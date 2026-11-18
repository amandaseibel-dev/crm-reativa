#!/usr/bin/env python3
"""Confere reproduzivelmente o funcoes_prod.sql contra funcoes_prod.json.

Para cada funcao do JSON: (1) a definicao completa (pg_get_functiondef) aparece
literalmente no SQL; (2) o md5 da definicao bate com o md5 registrado; (3) a
assinatura (nome + tipos de argumento, sem DEFAULT) bate com a do cabecalho
CREATE do SQL. Saida: uma linha por funcao, com o motivo de qualquer falha.
"""
import hashlib, json, pathlib, re, sys

B = pathlib.Path(__file__).parent
dados = json.loads((B / "funcoes_prod.json").read_text())["funcoes"]
sql = (B / "funcoes_prod.sql").read_text()

def assinatura_do_cabecalho(defn: str) -> str:
    m = re.search(r"CREATE OR REPLACE FUNCTION (\S+)\((.*?)\)\s*\n\s*RETURNS", defn, re.S)
    if not m:
        return "?"
    nome, args = m.group(1), m.group(2)
    tipos = []
    for a in [x.strip() for x in re.split(r",(?![^()]*\))", args) if x.strip()]:
        a = re.sub(r"\s+DEFAULT\s+.*$", "", a)          # remove DEFAULT do cabecalho
        partes = a.split()
        tipos.append(partes[-1] if len(partes) > 1 else partes[0])
    return f"{nome}({','.join(tipos)})"

def assinatura_do_json(nome: str) -> str:
    # nome = "public.f(p1 tipo1, p2 tipo2)" ; compara so os tipos
    m = re.match(r"(\S+)\((.*)\)$", nome)
    tipos = []
    for a in [x.strip() for x in m.group(2).split(",") if x.strip()]:
        partes = a.split()
        tipos.append(partes[-1] if len(partes) > 1 else partes[0])
    return f"{m.group(1)}({','.join(tipos)})"

falhas = 0
for f in dados:
    d = f["def"].rstrip()
    motivos = []
    if d not in sql:
        motivos.append("definicao completa ausente do SQL")
    if hashlib.md5(f["def"].encode()).hexdigest() != f["md5_def"]:
        motivos.append("md5 da definicao nao confere")
    if assinatura_do_cabecalho(f["def"]) != assinatura_do_json(f["nome"]):
        motivos.append(f"assinatura: cabecalho={assinatura_do_cabecalho(f['def'])} json={assinatura_do_json(f['nome'])}")
    status = "OK " if not motivos else "FALHA"
    falhas += bool(motivos)
    print(f"{status} {f['nome'][:90]} md5={f['md5_def'][:8]} {'; '.join(motivos)}")
print(f"total={len(dados)} falhas={falhas}")
sys.exit(1 if falhas else 0)
