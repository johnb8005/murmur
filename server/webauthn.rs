//! WebAuthn, the parts murmur uses: registration and authentication options shaped like
//! `@simplewebauthn/server` makes them (the app's `@simplewebauthn/browser` consumes them), and
//! verification of the responses. Attestation is requested as "none" and not checked: a
//! passkey app has no use for device provenance. Stored passkeys are what the TypeScript server
//! stored: the credential id (base64url), the raw COSE public key, the counter and the transports,
//! so existing rows keep working.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ciborium::value::{Integer, Value};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub const SUPPORTED_ALGS: [i64; 3] = [-8, -7, -257];

#[derive(Debug, Clone)]
pub struct StoredPasskey {
    /// base64url credential id
    pub id: String,
    /// raw COSE public key
    pub public_key: Vec<u8>,
    pub counter: i64,
    pub transports: Vec<String>,
}

pub struct Relying<'a> {
    pub name: &'a str,
    pub id: &'a str,
    pub origin: &'a str,
}

/// 32 random bytes, base64url: the string the browser echoes back in clientDataJSON.challenge.
pub fn new_challenge() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    B64.encode(bytes)
}

fn descriptors(creds: &[StoredPasskey]) -> Vec<serde_json::Value> {
    creds
        .iter()
        .map(|c| json!({ "id": c.id, "type": "public-key", "transports": c.transports }))
        .collect()
}

/// `generateRegistrationOptions`: discoverable, user verification preferred, attestation none.
pub fn registration_options(
    rp: &Relying,
    challenge: &str,
    user_id: &str,
    username: &str,
    exclude: &[StoredPasskey],
) -> serde_json::Value {
    json!({
        "challenge": challenge,
        "rp": { "name": rp.name, "id": rp.id },
        "user": { "id": B64.encode(user_id.as_bytes()), "name": username, "displayName": username },
        "pubKeyCredParams": SUPPORTED_ALGS.iter().map(|a| json!({ "alg": a, "type": "public-key" })).collect::<Vec<_>>(),
        "timeout": 60000,
        "attestation": "none",
        "excludeCredentials": descriptors(exclude),
        "authenticatorSelection": { "residentKey": "required", "requireResidentKey": true, "userVerification": "preferred" },
        "extensions": { "credProps": true },
    })
}

/// `generateAuthenticationOptions`: with `allow` empty the browser offers every discoverable passkey.
pub fn authentication_options(
    rp: &Relying,
    challenge: &str,
    allow: Option<&[StoredPasskey]>,
) -> serde_json::Value {
    let mut o = json!({ "rpId": rp.id, "challenge": challenge, "timeout": 60000, "userVerification": "preferred" });
    if let Some(allow) = allow {
        o["allowCredentials"] = serde_json::Value::Array(descriptors(allow));
    }
    o
}

// ---------- responses ----------

#[derive(Deserialize)]
pub struct RegistrationResponse {
    pub id: String,
    pub response: RegistrationInner,
}
#[derive(Deserialize)]
pub struct RegistrationInner {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "attestationObject")]
    pub attestation_object: String,
    #[serde(default)]
    pub transports: Vec<String>,
}

#[derive(Deserialize)]
pub struct AuthenticationResponse {
    pub id: String,
    pub response: AuthenticationInner,
}
#[derive(Deserialize)]
pub struct AuthenticationInner {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    pub signature: String,
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
}

fn b64(s: &str) -> Result<Vec<u8>> {
    B64.decode(s.trim_end_matches('='))
        .map_err(|e| anyhow!("bad base64url: {e}"))
}

fn check_client_data(raw: &[u8], kind: &str, challenge: &str, origin: &str) -> Result<()> {
    let cd: ClientData = serde_json::from_slice(raw).context("clientDataJSON")?;
    if cd.kind != kind {
        bail!("unexpected clientData type {}", cd.kind);
    }
    if cd.challenge.trim_end_matches('=') != challenge.trim_end_matches('=') {
        bail!("challenge mismatch");
    }
    if cd.origin != origin {
        bail!("unexpected origin {}", cd.origin);
    }
    Ok(())
}

struct AuthData<'a> {
    flags: u8,
    counter: u32,
    /// (credential id, raw COSE key) when the AT flag is set
    attested: Option<(&'a [u8], &'a [u8])>,
}

const FLAG_UP: u8 = 1 << 0;
const FLAG_AT: u8 = 1 << 6;

fn parse_auth_data<'a>(data: &'a [u8], rp_id: &str) -> Result<AuthData<'a>> {
    if data.len() < 37 {
        bail!("authenticator data too short");
    }
    if data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        bail!("rpIdHash mismatch");
    }
    let flags = data[32];
    let counter = u32::from_be_bytes([data[33], data[34], data[35], data[36]]);
    let attested = if flags & FLAG_AT != 0 {
        let rest = &data[37..];
        if rest.len() < 18 {
            bail!("attested credential data too short");
        }
        let id_len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
        let id = rest
            .get(18..18 + id_len)
            .ok_or_else(|| anyhow!("credential id truncated"))?;
        let key_start = 18 + id_len;
        let mut cursor = std::io::Cursor::new(&rest[key_start..]);
        let _: Value = ciborium::de::from_reader(&mut cursor).context("COSE key")?;
        let key_len = cursor.position() as usize;
        Some((id, &rest[key_start..key_start + key_len]))
    } else {
        None
    };
    Ok(AuthData {
        flags,
        counter,
        attested,
    })
}

fn cose_int(v: &Value) -> Option<i64> {
    match v {
        Value::Integer(i) => i128::from(*i).try_into().ok(),
        _ => None,
    }
}

fn cose_get(map: &[(Value, Value)], key: i64) -> Option<&Value> {
    let k = Integer::from(key);
    map.iter()
        .find(|(kk, _)| matches!(kk, Value::Integer(i) if *i == k))
        .map(|(_, v)| v)
}

fn cose_bytes(map: &[(Value, Value)], key: i64) -> Result<&[u8]> {
    match cose_get(map, key) {
        Some(Value::Bytes(b)) => Ok(b),
        _ => bail!("COSE key field {key} missing"),
    }
}

enum Key {
    Es256 { x: Vec<u8>, y: Vec<u8> },
    Rs256 { n: Vec<u8>, e: Vec<u8> },
    Ed25519 { x: Vec<u8> },
}

fn parse_cose(bytes: &[u8]) -> Result<Key> {
    let v: Value = ciborium::de::from_reader(bytes).context("COSE key")?;
    let map = match &v {
        Value::Map(m) => m,
        _ => bail!("COSE key is not a map"),
    };
    let kty = cose_get(map, 1)
        .and_then(cose_int)
        .ok_or_else(|| anyhow!("COSE kty missing"))?;
    let alg = cose_get(map, 3)
        .and_then(cose_int)
        .ok_or_else(|| anyhow!("COSE alg missing"))?;
    if !SUPPORTED_ALGS.contains(&alg) {
        bail!("unsupported algorithm {alg}");
    }
    match (kty, alg) {
        (2, -7) => {
            if cose_get(map, -1).and_then(cose_int) != Some(1) {
                bail!("ES256 needs curve P-256");
            }
            Ok(Key::Es256 {
                x: cose_bytes(map, -2)?.to_vec(),
                y: cose_bytes(map, -3)?.to_vec(),
            })
        }
        (3, -257) => Ok(Key::Rs256 {
            n: cose_bytes(map, -1)?.to_vec(),
            e: cose_bytes(map, -2)?.to_vec(),
        }),
        (1, -8) => {
            if cose_get(map, -1).and_then(cose_int) != Some(6) {
                bail!("EdDSA needs Ed25519");
            }
            Ok(Key::Ed25519 {
                x: cose_bytes(map, -2)?.to_vec(),
            })
        }
        _ => bail!("unsupported key type {kty} / algorithm {alg}"),
    }
}

fn verify_signature(key: &Key, message: &[u8], signature: &[u8]) -> Result<()> {
    match key {
        Key::Es256 { x, y } => {
            use p256::ecdsa::signature::Verifier;
            let point = p256::EncodedPoint::from_affine_coordinates(
                x.as_slice().into(),
                y.as_slice().into(),
                false,
            );
            let vk = p256::ecdsa::VerifyingKey::from_encoded_point(&point)
                .map_err(|_| anyhow!("bad P-256 key"))?;
            let sig = p256::ecdsa::DerSignature::from_bytes(signature)
                .map_err(|_| anyhow!("bad ES256 signature"))?;
            vk.verify(message, &sig)
                .map_err(|_| anyhow!("signature does not verify"))
        }
        Key::Rs256 { n, e } => {
            use rsa::signature::Verifier;
            let pk = rsa::RsaPublicKey::new(
                rsa::BigUint::from_bytes_be(n),
                rsa::BigUint::from_bytes_be(e),
            )
            .map_err(|_| anyhow!("bad RSA key"))?;
            let vk = rsa::pkcs1v15::VerifyingKey::<Sha256>::new(pk);
            let sig = rsa::pkcs1v15::Signature::try_from(signature)
                .map_err(|_| anyhow!("bad RS256 signature"))?;
            vk.verify(message, &sig)
                .map_err(|_| anyhow!("signature does not verify"))
        }
        Key::Ed25519 { x } => {
            let bytes: [u8; 32] = x
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("bad Ed25519 key"))?;
            let vk = ed25519_dalek::VerifyingKey::from_bytes(&bytes)
                .map_err(|_| anyhow!("bad Ed25519 key"))?;
            let sig = ed25519_dalek::Signature::from_slice(signature)
                .map_err(|_| anyhow!("bad EdDSA signature"))?;
            vk.verify_strict(message, &sig)
                .map_err(|_| anyhow!("signature does not verify"))
        }
    }
}

/// `verifyRegistrationResponse`: the new passkey (id, COSE key, counter, transports) or an error.
pub fn verify_registration(
    rp: &Relying,
    expected_challenge: &str,
    resp: &RegistrationResponse,
) -> Result<StoredPasskey> {
    let client_data = b64(&resp.response.client_data_json)?;
    check_client_data(
        &client_data,
        "webauthn.create",
        expected_challenge,
        rp.origin,
    )?;
    let att = b64(&resp.response.attestation_object)?;
    let att: Value = ciborium::de::from_reader(att.as_slice()).context("attestationObject")?;
    let map = match &att {
        Value::Map(m) => m,
        _ => bail!("attestationObject is not a map"),
    };
    let auth_bytes = match map
        .iter()
        .find(|(k, _)| matches!(k, Value::Text(t) if t == "authData"))
        .map(|(_, v)| v)
    {
        Some(Value::Bytes(b)) => b,
        _ => bail!("authData missing"),
    };
    let auth = parse_auth_data(auth_bytes, rp.id)?;
    if auth.flags & FLAG_UP == 0 {
        bail!("user not present during registration");
    }
    let (cred_id, cose) = auth
        .attested
        .ok_or_else(|| anyhow!("no attested credential data"))?;
    parse_cose(cose)?; // supported key type and algorithm
    let id = B64.encode(cred_id);
    if id != resp.id.trim_end_matches('=') {
        bail!("credential id mismatch");
    }
    Ok(StoredPasskey {
        id,
        public_key: cose.to_vec(),
        counter: auth.counter as i64,
        transports: resp.response.transports.clone(),
    })
}

/// `verifyAuthenticationResponse`: the new counter, or an error.
pub fn verify_authentication(
    rp: &Relying,
    expected_challenge: &str,
    cred: &StoredPasskey,
    resp: &AuthenticationResponse,
) -> Result<i64> {
    if resp.id.trim_end_matches('=') != cred.id {
        bail!("credential id mismatch");
    }
    let client_data = b64(&resp.response.client_data_json)?;
    check_client_data(&client_data, "webauthn.get", expected_challenge, rp.origin)?;
    let auth_bytes = b64(&resp.response.authenticator_data)?;
    let auth = parse_auth_data(&auth_bytes, rp.id)?;
    if auth.flags & FLAG_UP == 0 {
        bail!("user not present");
    }
    let new_counter = auth.counter as i64;
    if (new_counter > 0 || cred.counter > 0) && new_counter <= cred.counter {
        bail!("counter did not increase: possible cloned authenticator");
    }
    let key = parse_cose(&cred.public_key)?;
    let mut message = auth_bytes.clone();
    message.extend_from_slice(&Sha256::digest(&client_data));
    verify_signature(&key, &message, &b64(&resp.response.signature)?)?;
    Ok(new_counter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;

    const RP: Relying = Relying {
        name: "Murmur",
        id: "localhost",
        origin: "http://localhost:5173",
    };

    fn cose_es256(vk: &p256::ecdsa::VerifyingKey) -> Vec<u8> {
        let p = vk.to_encoded_point(false);
        let map = Value::Map(vec![
            (Value::Integer(1.into()), Value::Integer(2.into())),
            (Value::Integer(3.into()), Value::Integer((-7).into())),
            (Value::Integer((-1).into()), Value::Integer(1.into())),
            (
                Value::Integer((-2).into()),
                Value::Bytes(p.x().unwrap().to_vec()),
            ),
            (
                Value::Integer((-3).into()),
                Value::Bytes(p.y().unwrap().to_vec()),
            ),
        ]);
        let mut out = Vec::new();
        ciborium::ser::into_writer(&map, &mut out).unwrap();
        out
    }

    fn auth_data(flags: u8, counter: u32, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
        let mut d = Sha256::digest(RP.id.as_bytes()).to_vec();
        d.push(flags);
        d.extend_from_slice(&counter.to_be_bytes());
        if let Some((id, key)) = attested {
            d.extend_from_slice(&[0u8; 16]);
            d.extend_from_slice(&(id.len() as u16).to_be_bytes());
            d.extend_from_slice(id);
            d.extend_from_slice(key);
        }
        d
    }

    fn client_data(kind: &str, challenge: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({ "type": kind, "challenge": challenge, "origin": RP.origin }))
            .unwrap()
    }

    #[test]
    fn register_then_authenticate_es256() {
        let sk = p256::ecdsa::SigningKey::random(&mut rand::thread_rng());
        let cose = cose_es256(sk.verifying_key());
        let cred_id = b"credential-1";
        let challenge = new_challenge();

        let mut att = Vec::new();
        ciborium::ser::into_writer(
            &Value::Map(vec![
                (Value::Text("fmt".into()), Value::Text("none".into())),
                (Value::Text("attStmt".into()), Value::Map(vec![])),
                (
                    Value::Text("authData".into()),
                    Value::Bytes(auth_data(FLAG_UP | FLAG_AT, 0, Some((cred_id, &cose)))),
                ),
            ]),
            &mut att,
        )
        .unwrap();
        let reg = RegistrationResponse {
            id: B64.encode(cred_id),
            response: RegistrationInner {
                client_data_json: B64.encode(client_data("webauthn.create", &challenge)),
                attestation_object: B64.encode(&att),
                transports: vec!["internal".into()],
            },
        };
        let stored = verify_registration(&RP, &challenge, &reg).expect("registration verifies");
        assert_eq!(stored.public_key, cose);
        assert_eq!(stored.id, B64.encode(cred_id));
        assert!(
            verify_registration(&RP, "other", &reg).is_err(),
            "wrong challenge rejected"
        );

        let challenge = new_challenge();
        let cd = client_data("webauthn.get", &challenge);
        let ad = auth_data(FLAG_UP, 7, None);
        let mut msg = ad.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let sig: p256::ecdsa::DerSignature = sk.sign(&msg);
        let resp = AuthenticationResponse {
            id: stored.id.clone(),
            response: AuthenticationInner {
                client_data_json: B64.encode(&cd),
                authenticator_data: B64.encode(&ad),
                signature: B64.encode(sig.as_bytes()),
            },
        };
        assert_eq!(
            verify_authentication(&RP, &challenge, &stored, &resp).expect("assertion verifies"),
            7
        );

        let replayed = StoredPasskey {
            counter: 7,
            ..stored.clone()
        };
        assert!(
            verify_authentication(&RP, &challenge, &replayed, &resp).is_err(),
            "stale counter rejected"
        );
        let other = StoredPasskey {
            public_key: cose_es256(
                p256::ecdsa::SigningKey::random(&mut rand::thread_rng()).verifying_key(),
            ),
            ..stored.clone()
        };
        assert!(
            verify_authentication(&RP, &challenge, &other, &resp).is_err(),
            "wrong key rejected"
        );
        assert!(
            verify_authentication(&RP, "other", &stored, &resp).is_err(),
            "wrong challenge rejected"
        );
    }

    #[test]
    fn options_shape() {
        let o = registration_options(&RP, "c", "u1", "johan", &[]);
        assert_eq!(o["authenticatorSelection"]["residentKey"], "required");
        assert_eq!(o["user"]["id"], B64.encode(b"u1"));
        let a = authentication_options(&RP, "c", None);
        assert!(a.get("allowCredentials").is_none());
    }
}
