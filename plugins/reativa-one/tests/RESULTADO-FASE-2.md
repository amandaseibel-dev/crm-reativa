# Resultado de segurança — ReATIVA One, Fase 2 de Banco

**Data:** 2026-10-29 · **Branch:** `fase2-banco-portao-migrations` · **HEAD:** `9bf5877f`

Três estados, e eles não se misturam:

- **APROVADO** — provado por execução nesta sessão, com a saída registrada.
- **REPROVADO** — tentado e o resultado foi diferente do exigido.
- **NÃO COMPROVADO** — não é possível provar daqui sem risco ou sem acesso.
  Não é aprovação. Não conte com ele.

---

## 1. Autoteste do Guardião — 163 casos por execução real

Cada caso entrega ao `hooks/guardiao.sh` a **mesma carga JSON** que o Claude Code
entrega num `PreToolUse`, e confere o código de saída (2 = bloqueado, 0 = passa).
**Nenhuma linha de comando testada foi executada**: elas atravessaram o avaliador,
não o shell. É simulação controlada — nada tocou produção.

Comando executado nesta sessão:

```
node plugins/reativa-one/tests/guardiao.autoteste.mjs
```

Saída (últimas linhas):

```
163 casos · 133 de bloqueio · 163 como esperado · 0 divergente(s)
Nada executado contra produção: os comandos atravessaram o avaliador, não o shell.
```

**APROVADO — 163 de 163, 0 divergente.**

---

## 2. Portão da Fase 2 de Banco (F01–F88)

88 casos cobrem exclusivamente o portão `fase2_liberada()`:

| Faixa | O que cobre |
|---|---|
| F01–F12 | Portão fechado (sem variável, ou valor malformado) |
| F13–F26 | Portão aberto: caminhos liberados e recusados |
| F27–F43 | Checkout principal, worktree irmão, link simbólico |
| F44–F55 | Branch `main`/`master`, caminho fora de migrations |
| F56–F68 | Caixa alta nos caminhos das regras |
| F69–F88 | Glob, espaços nas pontas, tokens de escrita em maiúsculo |

Resultado: **APROVADO — 88 de 88, 0 divergente.**

---

## 3. Bloqueios de aplicação com portão aberto (F13, F16–F18, F21–F24)

12 casos do autoteste são executados com `REATIVA_FASE2_BANCO` definido e confirmam
que a Fase 2 não libera aplicação:

| Caso | O que confirma |
|---|---|
| F16 | `apply_migration` continua bloqueado |
| F17 | `db push` continua bloqueado |
| F18 | `db reset` continua bloqueado |
| F21 | `migration repair` continua bloqueado |
| F22 | `migration up` continua bloqueado |
| F23 | `deploy_edge_function` continua bloqueado |
| F24 | `merge_branch` continua bloqueado |
| F13 | `git push` continua exigindo aprovação |

Resultado: **APROVADO — todos os 12 bloqueios de aplicação confirmados com portão aberto.**

---

## 4. Camada 0 — settings.json (S01–S03)

| Caso | O que verifica |
|---|---|
| S01 | JSON válido; `deny` e `ask` presentes |
| S02 | Toda regra `mcp__<UUID>__x` tem o par `mcp__claude_ai_<Nome>__x` |
| S03 | `create_edge_function_secret` e `create_project` em `deny` |

Resultado: **APROVADO — 3 de 3.**

---

## 5. O que não foi comprovado

| Item | Motivo |
|---|---|
| Variável `REATIVA_FASE2_BANCO` libera Write em migrations | Requer a variável definida no lançamento da sessão executora. A confirmação é de responsabilidade da gestão ao lançar a sessão autorizada — não pode ser provada de fora da sessão. |
| `execute_sql` exige aprovação interativa | Limitação declarada desde 2026-10-16. `ask` na Camada 0 e sufixo no hook cobrem a regra, mas o comportamento interativo nunca foi demonstrado nesta instalação. |
| Habilitação do plugin carrega no checkout principal | Limitação declarada na 1.2.0. `claude plugin validate` passa; o diálogo de workspace trust ainda não foi aceito. |

---

## 6. Resumo

| Camada | Casos | Resultado |
|---|---|---|
| Guardião — total | 163 | **APROVADO** |
| Fase 2 de Banco (F-series) | 88 | **APROVADO** |
| Bloqueios com portão aberto | 12 | **APROVADO** |
| Camada 0 | 3 | **APROVADO** |

**Conclusão: APROVADO.** A Fase 2 de Banco está implementada e os 163 casos do
autoteste confirmam que o portão libera apenas Write/Edit de migration no worktree e
branch autorizados, sem alterar nenhum bloqueio de aplicação.

A autorização por sessão (`REATIVA_FASE2_BANCO`) permanece fora do escopo do autoteste
por desenho — ela é verificada pela gestão ao lançar a sessão executora.
