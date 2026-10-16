---
name: fontes-de-verdade
description: Diz qual arquivo do repositório manda em cada assunto do CRM ReATIVA — regra de negócio, saldo, acordo, fila, pagamento, migration, segurança, Prime/ULBRA, indicadores — e onde está a evidência medida. Use antes de responder qualquer "qual é a regra?", antes de implementar regra ou fallback, e sempre que a resposta parecer vir da memória em vez de vir de arquivo.
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Onde mora a verdade neste repositório

Este arquivo **não contém regra nenhuma**. Ele é um roteador: aponta o arquivo
que manda, para a regra ser lida da fonte e não reescrita de memória. Regra
duplicada é regra que divergiu — é a Premissa 12 aplicada à documentação.

**Conversa anterior não é fonte primária.** Se um chat souber algo que não está
em arquivo versionado, o chat está desatualizado, não o contrário.

## Roteador

| Assunto | Abra | Observação |
|---|---|---|
| Qualquer coisa de **Prime/ULBRA** | `CLAUDE.md` → `docs/integracoes/README.md` | **Obrigatório, antes de investigar.** São 6 passos; o passo 1 é não iniciar descoberta nova sem conferir o catálogo |
| Rota, campo, limite da API Prime | `docs/integracoes/prime-api.md` + `prime-api-catalog.json` | o `.json` é a versão legível por ferramenta |
| Qual fonte é oficial para um dado | `docs/integracoes/prime-mapa-fontes-verdade.md` | matriz informação → fonte → endpoint → chave |
| CPF, matrícula, boleto, nº Ulbra | `docs/integracoes/prime-mapa-identificadores.md` | quem gera, se é estável, se serve para casar |
| O que a API **não** entrega | `docs/integracoes/prime-gaps.md` | VERDE/AMARELO/VERMELHO |
| **Premissas do sistema** (1 a 11) | `docs/PREMISSAS.md` | dívida · Prime · fila e carteira · pagamento · acordo |
| **Como se escreve** (12 a 15) | `docs/PREMISSAS.md` §"Como se escreve" | regra no banco · paginação com desempate · quem mais escreve na coluna · migration commitada no mesmo dia |
| Saldo cobrável | `docs/REGRA-SALDO-COBRAVEL.md` | |
| Vínculo título × acordo | `docs/CLASSIFICACAO-VINCULO-ACORDO-MENSALIDADE.md`, `docs/PLANO-VINCULO-TITULO-ACORDO.md` | |
| Código, status, enum | `docs/DICIONARIO-CODIGOS.md` | o catálogo **não** governa o `select` da tela: há cópias fixas |
| **Migration** | `docs/RUNBOOK-MIGRATIONS.md` | `db push` é proibido; V1–V4; D3 congelados |
| O que rodou em produção | `supabase/ledger/` + `INDICE.tsv` + `LEIA-ME.md` | md5 byte a byte é a prova; não se edita |
| Distância entre repo e produção | `supabase/ledger/DUAS-TRILHAS.md` | |
| **Segurança, RLS, perfis, LGPD** | `docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md` | ver a skill `seguranca-rls` |
| Publicação | `docs/seguranca/CHECKLIST_SEGURANCA_DEPLOY.md` | preencher de verdade, item por item |
| Dívida técnica conhecida | `docs/BACKLOG-TECNICO.md` | "não implementar sem aprovação" vale |
| Catracas do CI | `.github/workflows/ci.yml`, `scripts/ci/*.mjs` | legado tolerado, nada pode piorar |

Quando o assunto não estiver na tabela: `ls docs/` e `grep -ril "<termo>" docs/`
antes de concluir que não existe. São 94 arquivos.

## Antes de afirmar um número

Três erros que já passaram por aqui com cara de número certo:

1. **Consulta cortada em 1.000 linhas** responde `206` — sucesso. Toda lista
   longa usa `buscarTudo` e termina em `.order("id")`.
2. **Timestamp igual não prova causa.** Mesma transação não é causalidade.
3. **Critério sem grupo de controle não discrimina nada.** Ordenar não é
   comprovar; desempate por uuid é sorteio.

Número sem prova se declara **NÃO COMPROVADO**. É uma resposta legítima.
