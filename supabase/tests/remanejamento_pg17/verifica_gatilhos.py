#!/usr/bin/env python3
"""Compara os gatilhos CARREGADOS no banco de CI com a LISTA DE PRODUCAO (somente leitura).

Entrada: arquivo com 'tabela.gatilho' por linha (carregados no CI) e a lista de producao em
protecao_prod_20261118/estruturas_prod.json, e a triagem em triagem_gatilhos.json.
Regra: cada gatilho de producao das tabelas alunos, casos e acordos deve estar CARREGADO
ou CLASSIFICADO na triagem (INCLUIR ou EXCLUIR). Avaliar zero gatilhos e falha.
"""
import json, pathlib, sys
B = pathlib.Path(__file__).resolve().parents[2] / "fixtures" / "protecao_prod_20261118"
carregados = {l.strip() for l in open(sys.argv[1]) if l.strip()}
producao = [t for t in json.loads((B / "estruturas_prod.json").read_text())["estruturas"]["gatilhos"]
            if t["tabela"] in ("alunos", "casos", "acordos")]
triagem = {(r["tabela"], r["gatilho"]): r for r in json.loads((B / "triagem_gatilhos.json").read_text())}
avaliados = 0; sem_classe = []; incluir_sem_carga = []
for t in producao:
    chave = f"{t['tabela']}.{t['nome']}"
    avaliados += 1
    if chave in carregados:
        continue
    r = triagem.get((t["tabela"], t["nome"]))
    if r is None:
        sem_classe.append(chave)
    elif r["decisao"] == "INCLUIR":
        incluir_sem_carga.append(chave)
for r in triagem.values():
    if r["decisao"] == "INCLUIR" and f"{r['tabela']}.{r['gatilho']}" not in carregados:
        incluir_sem_carga.append(f"{r['tabela']}.{r['gatilho']}")
print(f"gatilhos de producao avaliados: {avaliados}")
print(f"carregados no CI: {len(carregados)}")
print(f"sem classificacao (falha): {len(sem_classe)}")
for c in sem_classe: print("  SEM CLASSE:", c)
print(f"INCLUIR nao carregado (falha): {len(incluir_sem_carga)}")
for c in incluir_sem_carga: print("  INCLUIR SEM CARGA:", c)
if avaliados == 0:
    print("FALHA: zero gatilhos avaliados"); sys.exit(1)
sys.exit(1 if (sem_classe or incluir_sem_carga) else 0)
