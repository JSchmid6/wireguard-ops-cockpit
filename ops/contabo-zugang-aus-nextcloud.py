#!/usr/bin/python3
"""Den Contabo-API-Zugang aus dem Nextcloud-Passwortspeicher holen und fuer
das Cockpit hinterlegen — ohne dass ein Wert je auf dem Bildschirm, im
Verlauf oder in einem Chat landet.

Jochen, 12.09.2026: „die login Daten kannst vielleicht über die nextcloud
beziehen und in einem script verwenden." Genau das: Der Eintrag lebt in der
Passwords-App, wo er gepflegt wird; dieses Skript liest ihn mit einer
hinterlegten Vollmacht (App-Passwort eines Kontos) und schreibt die Felder
direkt nach /etc/wireguard-ops-cockpit/contabo.env (root, 600). Was es
ausgibt, sind Feldnamen und die Probe des Helfers — nie Werte.

## Welcher Eintrag

Der Eintrag, dessen Bezeichnung oder URL „contabo" enthaelt. Gibt es mehrere,
gewinnt der mit den meisten passenden Feldern; bei Gleichstand muss die
Kennung per --eintrag genannt werden.

## Welche Felder

Die Contabo-API braucht vier Werte. Sie kommen so aus dem Eintrag:

    CONTABO_API_USER       Benutzername des Eintrags   (oder Feld api_user)
    CONTABO_API_PASSWORD   Passwort des Eintrags       (oder Feld api_password)
    CONTABO_CLIENT_ID      benutzerdefiniertes Feld    client_id
    CONTABO_CLIENT_SECRET  benutzerdefiniertes Feld    client_secret
    CONTABO_INSTANCE_ID    benutzerdefiniertes Feld    instance_id  (optional)

Feldnamen werden ohne Ruecksicht auf Gross-/Kleinschreibung, Leerzeichen,
Bindestriche und Unterstriche verglichen („Client ID" == client_id). Fehlt
etwas, sagt das Skript, welche Felder im Nextcloud-Eintrag anzulegen sind,
und schreibt nichts. Das Panel-Passwort ist NICHT das API-Passwort; Contabo
vergibt das getrennt unter Account -> API.

## Vollmacht

Standard: das Konto Jochen ueber die Datei nextcloud-app-password-jochen im
Zugangsverzeichnis von Hermes — dieselbe Vollmacht, mit der auch das
Gedaechtnis Dateien liest. Ein anderes Konto: --konto <name>. Der Tresor von
Hermes (nur freigegebene Eintraege): --konto hermes --datei
nextcloud-app-password-hermes-tresor.

Aufruf als root:   python3 contabo-zugang-aus-nextcloud.py [--konto Jochen] [--eintrag <id>] [--probe-nur]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASIS = os.environ.get("NEXTCLOUD_URL", "https://nextcloud.wejos.de").rstrip("/")
API = "/index.php/apps/passwords/api/1.0"
ZIEL = Path("/etc/wireguard-ops-cockpit/contabo.env")
HELFER = "/usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot"
ZUGANGS_VERZEICHNISSE = ("/home/hermes/.hermes/credentials", "/opt/data/credentials")

# Zielvariable -> akzeptierte Feldnamen (normalisiert: klein, ohne Trenner)
FELDER = {
    "CONTABO_CLIENT_ID": ("clientid",),
    "CONTABO_CLIENT_SECRET": ("clientsecret",),
    "CONTABO_API_USER": ("apiuser", "apiusername", "apinutzer", "apibenutzer"),
    "CONTABO_API_PASSWORD": ("apipassword", "apipasswort", "apipass"),
    "CONTABO_INSTANCE_ID": ("instanceid", "instanzid", "instanz", "instance"),
}
PFLICHT = ("CONTABO_CLIENT_ID", "CONTABO_CLIENT_SECRET", "CONTABO_API_USER", "CONTABO_API_PASSWORD")


def die(text: str, code: int = 1) -> "NoReturn":  # noqa: F821
    sys.stdout.flush()  # was schon gesagt wurde, soll vor der Absage stehen
    sys.stderr.write(text.rstrip() + "\n")
    sys.exit(code)


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def vollmacht(konto: str, datei: str | None) -> str:
    name = datei or f"nextcloud-app-password-{re.sub(r'[^A-Za-z0-9_-]', '_', konto).lower()}"
    for wurzel in ZUGANGS_VERZEICHNISSE:
        pfad = Path(wurzel) / name
        try:
            if pfad.stat().st_mode & 0o077:
                die(f"{pfad} ist fuer andere lesbar — so wird sie nicht benutzt.", 69)
            return pfad.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            continue
    die(f"keine Vollmacht {name} in {' oder '.join(ZUGANGS_VERZEICHNISSE)}; das Konto meldet sich per nextcloud_anmelden an", 69)


def passwoerter(konto: str, passwort: str) -> list[dict]:
    """Alle Eintraege, die das Konto sieht. Bei 401 noch einmal mit anderer
    Schreibweise des Kontonamens — Dateinamen sind klein, Konten nicht immer."""
    versuche = [konto] + [v for v in (konto.lower(), konto.capitalize()) if v != konto]
    letzter = ""
    for nutzer in versuche:
        anfrage = urllib.request.Request(f"{BASIS}{API}/password/list")
        anfrage.add_header("Authorization", "Basic " + base64.b64encode(f"{nutzer}:{passwort}".encode()).decode())
        anfrage.add_header("OCS-APIRequest", "true")
        try:
            with urllib.request.urlopen(anfrage, timeout=60) as antwort:
                return json.loads(antwort.read())
        except urllib.error.HTTPError as fehler:
            letzter = f"HTTP {fehler.code}"
            if fehler.code != 401:
                break
        except OSError as fehler:
            die(f"Passwortspeicher nicht erreichbar: {fehler}", 70)
    die(f"Passwortspeicher lehnt das Konto {konto} ab ({letzter}).", 69)


def ist_client_eintrag(eintrag: dict) -> bool:
    """Ein Eintrag, dessen Bezeichnung „client" enthaelt, traegt Client ID
    und Secret als Benutzername und Passwort — so hat Jochen ihn angelegt
    („API-contabo-clientID: Nutzer ist clientID und PW das Secret")."""
    return bool(re.search(r"client", str(eintrag.get("label") or ""), re.I))


def felder_von(eintrag: dict) -> dict[str, str]:
    """Die Zielvariablen, die dieser Eintrag liefert. Werte werden nur
    weitergereicht, nie ausgegeben.

    Benutzerdefinierte Felder zuerst; was dann noch fehlt, kommt aus
    Benutzername und Passwort — bei einem Client-Eintrag als ID und Secret,
    sonst als API-Nutzer und API-Passwort."""
    roh = eintrag.get("customFields") or "[]"
    try:
        eigene = json.loads(roh) if isinstance(roh, str) else roh
    except ValueError:
        eigene = []
    nach_name = {norm(f.get("label")): f.get("value") for f in eigene if isinstance(f, dict) and f.get("value")}
    werte: dict[str, str] = {}
    for ziel, namen in FELDER.items():
        for name in namen:
            if nach_name.get(name):
                werte[ziel] = str(nach_name[name]).strip()
                break
    nutzer = (eintrag.get("username") or "").strip()
    passwort = (eintrag.get("password") or "").strip()
    if ist_client_eintrag(eintrag):
        werte.setdefault("CONTABO_CLIENT_ID", nutzer)
        werte.setdefault("CONTABO_CLIENT_SECRET", passwort)
    else:
        werte.setdefault("CONTABO_API_USER", nutzer)
        werte.setdefault("CONTABO_API_PASSWORD", passwort)
    return {k: v for k, v in werte.items() if v}


def kandidaten(eintraege: list[dict], kennung: str | None) -> list[dict]:
    if kennung:
        return [e for e in eintraege if e.get("id") == kennung]
    return [e for e in eintraege
            if "contabo" in " ".join(str(e.get(k) or "") for k in ("label", "url")).lower() and not e.get("trashed")]


def beschreibe(eintrag: dict) -> str:
    vorhanden = sorted(felder_von(eintrag))
    return f"{eintrag.get('id')}  „{eintrag.get('label')}\"  liefert: {', '.join(vorhanden) or 'nichts'}"


def schreibe(werte: dict[str, str]) -> None:
    ZIEL.parent.mkdir(mode=0o700, exist_ok=True)
    zeilen = "".join(f"{k}={werte.get(k, '')}\n" for k in ("CONTABO_CLIENT_ID", "CONTABO_CLIENT_SECRET", "CONTABO_API_USER", "CONTABO_API_PASSWORD", "CONTABO_INSTANCE_ID"))
    fd = os.open(ZIEL, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, zeilen.encode("utf-8"))
    finally:
        os.close(fd)
    os.chown(ZIEL, 0, 0)
    ZIEL.chmod(0o600)


def probe() -> int:
    lauf = subprocess.run(["/usr/bin/python3", HELFER, "status"], capture_output=True, text=True, timeout=120)
    if lauf.returncode != 0:
        sys.stderr.write(f"Probe fehlgeschlagen ({lauf.returncode}): {lauf.stderr.strip()[:300]}\n")
        return lauf.returncode
    daten = json.loads(lauf.stdout)
    inst = daten["instance"]
    print(f"  Instanz {inst['instanceId']} {inst['name']} ({inst['status']}, {inst.get('productId')}), {daten['snapshotCount']} Snapshot(s) vorhanden")
    for s in daten["snapshots"]:
        print(f"  - {s['snapshotId']} {s['name']} angelegt {s['createdDate']} weg am {s['autoDeleteDate']}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--konto", default="Jochen", help="Nextcloud-Konto, dessen Vollmacht gelesen wird (Standard: Jochen)")
    parser.add_argument("--datei", default=None, help="Name der Vollmachtsdatei, falls nicht nextcloud-app-password-<konto>")
    parser.add_argument("--eintrag", default=None, help="Kennung des Eintrags, wenn die Suche nach „contabo\" nicht eindeutig ist")
    parser.add_argument("--probe-nur", action="store_true", help="nur pruefen, was der Eintrag liefert; nichts schreiben")
    args = parser.parse_args()
    if os.geteuid() != 0:
        die("Bitte als root: die Zieldatei gehoert root.", 64)

    eintraege = passwoerter(args.konto, vollmacht(args.konto, args.datei))
    treffer = kandidaten(eintraege, args.eintrag)
    if not treffer:
        die(f"Im Passwortspeicher von {args.konto} gibt es keinen Eintrag mit „contabo\" in Bezeichnung oder URL "
            f"({len(eintraege)} Eintraege gesehen). Anlegen: Bezeichnung „Contabo API\", Benutzername = Konto-E-Mail, "
            "Passwort = API-Passwort (Account -> API), Felder client_id und client_secret.", 66)
    # Die vier Werte duerfen ueber mehrere Eintraege verteilt sein: einer fuer
    # den API-Login („auth.contabo"), einer fuer die Client-Zugangsdaten
    # („API-contabo-clientID"). Zusammengefuehrt wird in Rangfolge — wer
    # zuerst kommt, behaelt sein Feld: Eintraege, die nach API oder auth
    # klingen, vor Client-Eintraegen, vor dem blossen Panel-Login
    # („my.contabo.com"), dessen Passwort NICHT das API-Passwort ist.
    def rang(e: dict) -> tuple[int, int, int]:
        label = str(e.get("label") or "")
        return (int(bool(re.search(r"auth|api", label, re.I)) and not ist_client_eintrag(e)),
                int(ist_client_eintrag(e)), len(felder_von(e)))
    treffer.sort(key=rang, reverse=True)
    werte: dict[str, str] = {}
    benutzt: list[dict] = []
    for e in treffer:
        neu = {k: v for k, v in felder_von(e).items() if k not in werte}
        if neu:
            werte.update(neu)
            benutzt.append(e)
        if all(k in werte for k in PFLICHT):
            break
    for e in benutzt:
        print(f"Eintrag: {beschreibe(e)}")
    fehlend = [k for k in PFLICHT if k not in werte]
    if fehlend:
        hinweise = {
            "CONTABO_CLIENT_ID": "benutzerdefiniertes Feld „client_id\" (aus my.contabo.com -> Account -> API)",
            "CONTABO_CLIENT_SECRET": "benutzerdefiniertes Feld „client_secret\" (ebenda)",
            "CONTABO_API_USER": "Benutzername des Eintrags = E-Mail des Contabo-Kontos",
            "CONTABO_API_PASSWORD": "Passwort des Eintrags = API-Passwort (ebenda gesetzt; nicht das Panel-Passwort) oder Feld „api_password\"",
        }
        die("Der Eintrag reicht noch nicht. Im Nextcloud-Eintrag ergaenzen:\n" + "\n".join(f"  - {hinweise[k]}" for k in fehlend) + "\nDann dieses Skript erneut ausfuehren.", 65)
    if args.probe_nur:
        print("Alle Pflichtfelder vorhanden; nichts geschrieben (--probe-nur).")
        return
    schreibe(werte)
    print(f"Hinterlegt: {ZIEL} (root 600), {len(werte)} Werte. Probe beim Hoster:")
    sys.exit(probe())


if __name__ == "__main__":
    main()
