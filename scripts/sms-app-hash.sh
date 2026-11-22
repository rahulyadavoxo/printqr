#!/usr/bin/env bash
# SMS Retriever app hash (11 characters) for the Android app, used at the end of the OTP SMS
# (Supabase secret SMS_APP_HASH, read by supabase/functions/send-sms). Not a secret.
#
#   scripts/sms-app-hash.sh path/to/PrintQR.apk                 # from a signed APK (v1, v2 or v3 signature)
#   scripts/sms-app-hash.sh path/to/upload.p12 [alias]          # from the signing keystore (asks for the password;
#                                                               #  or set PQ_KEY_PASS). Default alias: upload
#   scripts/sms-app-hash.sh path/to/deployment_cert.der         # Play App Signing cert (Play Console -> App signing)
#
# Algorithm (developers.google.com/identity/sms-retriever/verify, AppSignatureHelper):
#   base64( SHA-256( "<package> <lower-case hex of the signing cert DER>" ) )[0..11]
# Different signing keys give different hashes: the GitHub APK and the Play Store build (Play App Signing) differ.
# Needs python3 (no extra modules); keytool only for a keystore.
set -euo pipefail
PKG="${SMS_PKG:-in.receipto.print}"
IN="${1:?usage: $0 <apk | keystore.p12 | cert.der> [alias]}"
ALIAS="${2:-upload}"
[ -f "$IN" ] || { echo "not found: $IN" >&2; exit 1; }

case "$IN" in
  *.apk) MODE=apk ;;
  *.der|*.cer|*.crt) MODE=der ;;
  *) MODE=keystore ;;
esac

if [ "$MODE" = keystore ]; then
  command -v keytool >/dev/null || { echo "keytool (JDK) is needed for a keystore" >&2; exit 1; }
  TYPE=()
  case "$IN" in *.p12|*.pfx) TYPE=(-storetype pkcs12) ;; esac
  PASS=()
  [ -n "${PQ_KEY_PASS:-}" ] && PASS=(-storepass:env PQ_KEY_PASS)
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT
  # keytool -exportcert writes the certificate as binary DER
  keytool -exportcert -keystore "$IN" ${TYPE[@]+"${TYPE[@]}"} ${PASS[@]+"${PASS[@]}"} -alias "$ALIAS" -file "$TMP" >&2
  [ -s "$TMP" ] || { echo "keytool gave no certificate (wrong alias or password?)" >&2; exit 1; }
  IN="$TMP"
  MODE=der
fi

python3 - "$PKG" "$MODE" "$IN" <<'PY'
import sys, struct, zipfile, hashlib, base64
pkg, mode, path = sys.argv[1], sys.argv[2], sys.argv[3]

def u32(b, o): return struct.unpack_from('<I', b, o)[0]
def seq(b):
    """Items of a uint32-length-prefixed sequence."""
    o, out = 0, []
    while o < len(b):
        n = u32(b, o); out.append(b[o + 4:o + 4 + n]); o += 4 + n
    return out
def lp(b, o):
    n = u32(b, o); return b[o + 4:o + 4 + n], o + 4 + n

def certs_v2v3(data):
    # End of central directory -> central directory offset -> APK Signing Block just before it.
    eocd = data.rfind(b'PK\x05\x06')
    if eocd < 0: return None
    cd = u32(data, eocd + 16)
    if data[cd - 16:cd] != b'APK Sig Block 42': return None
    size = struct.unpack_from('<Q', data, cd - 24)[0]
    start = cd - size - 8
    o, end, blocks = start + 8, cd - 24, {}
    while o < end:
        n = struct.unpack_from('<Q', data, o)[0]
        bid = u32(data, o + 8)
        blocks[bid] = data[o + 12:o + 8 + n]
        o += 8 + n
    # v3 (0xf05368c0) first: after key rotation it names the current signer. Then v2 (0x7109871a).
    for bid in (0xf05368c0, 0x7109871a):
        if bid not in blocks: continue
        signers, _ = lp(blocks[bid], 0)
        for signer in seq(signers):
            signed, _ = lp(signer, 0)
            _digests, p = lp(signed, 0)
            certs, _ = lp(signed, p)
            c = seq(certs)
            if c: return c[0]
    return None

def cert_v1(path):
    # v1 (JAR) signature: PKCS#7 in META-INF/*.RSA|DSA|EC; take the first certificate with a tiny DER walk.
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.upper().startswith('META-INF/') and n.upper().rsplit('.', 1)[-1] in ('RSA', 'DSA', 'EC')]
        if not names: return None
        p7 = z.read(names[0])
    def tlv(b, o):
        t = b[o]; l = b[o + 1]; o += 2
        if l & 0x80:
            k = l & 0x7f; l = int.from_bytes(b[o:o + k], 'big'); o += k
        return t, o, l
    # ContentInfo SEQ -> [OID, [0] -> SignedData SEQ -> version, digestAlgs, contentInfo, [0] certs -> first cert
    _, o, _ = tlv(p7, 0)
    _, o2, l = tlv(p7, o); o = o2 + l              # contentType OID
    _, o, _ = tlv(p7, o)                           # [0]
    _, o, _ = tlv(p7, o)                           # SignedData SEQUENCE
    for _ in range(3):
        _, o2, l = tlv(p7, o); o = o2 + l          # version, digestAlgorithms, encapContentInfo
    t, o, _ = tlv(p7, o)                           # [0] certificates
    if t != 0xa0: return None
    _, o2, l = tlv(p7, o)
    return p7[o:o2 + l]

if mode == 'der':
    der = open(path, 'rb').read()
else:
    der = certs_v2v3(open(path, 'rb').read()) or cert_v1(path)
    if not der: sys.exit('no signing certificate found in the APK')
hexs = der.hex()
print("cert SHA-1:   " + ":".join(f"{b:02X}" for b in hashlib.sha1(der).digest()), file=sys.stderr)
print("cert SHA-256: " + ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest()), file=sys.stderr)
print(base64.b64encode(hashlib.sha256(f"{pkg} {hexs}".encode()).digest()).decode()[:11])
PY
