# Reconciliação cadastral — Sâmara Moreno (matrículas 12876 × 12370)

> Investigação **somente leitura**. Nenhum dado de produção foi alterado.
> Branch: `fix/reconciliacao-cadastral-samara`. Data: 2026-07-26.

## 1. Conclusão sobre a identidade

**É comprovadamente a MESMA pessoa** — provado por dois vínculos fortes, não por
coincidência de nome:

| Evidência | Valor |
|-----------|-------|
| `aluno_id` (idêntico em `alunos` e `casos`) | `7a7460b8-8550-4583-bfea-9ea4e5e5a0fa` |
| CPF (idêntico, normalizado) | `01046168142` |

Não existe segundo `aluno` para este CPF (verificado). As matrículas 12370 e 12876
aparecem **uma única vez cada**, ambas apontando para o mesmo `aluno_id` e o mesmo CPF.
Nenhuma delas pertence a terceiros.

## 2. Registros encontrados

| Tabela | Chave | Matrícula | Nome | CPF | Criado em |
|--------|-------|-----------|------|-----|-----------|
| `alunos` | id `7a7460b8…` | **12370** | "Sâmara Moreno" (abreviado) | 01046168142 | 2026-06-29 09:21 |
| `casos` | aluno_id `7a7460b8…` | **12876** | "Sâmara Paola Ennes Moreno" (completo) | 01046168142 (cpf_limpo) | 2026-06-29 09:44 |
| `alunos_unificados` | cpf_ref 01046168142 | — | "Sâmara Moreno" (qtd_cpfs=1) | — | — |
| `acordos` | aluno_id `7a7460b8…` | — | — | 01046168142 | ATIVO |

### Financeiro (tudo preso ao `aluno_id`, intacto)
- 1 acordo **ATIVO** `d1d00c5f-b62e-4af1-8f9e-b1a9ca9689ef` — total **R$ 20.942,97**.
- 3 parcelas de R$ 6.980,99 (nº1 VENCIDA 19/07; nº2 e nº3 A_VENCER). **Nenhum pagamento**.
- 0 registros em `pagamentos`, `acordos_titulos`, `solicitacoes_confirmacao_pagamento`,
  `links_pagamento` para este aluno/CPF.
- 13 `aluno_movimentacoes` (cargas retroativas, atendimento da operadora Nataly,
  sincronizações e troca de responsável do acordo para amanda.seibel — 23/07).

## 3. Causa da divergência

- A linha em `alunos` (matrícula 12370, nome abreviado) tem
  `unificacao_status = REFERENCIA_POR_NOME` e `chave_unificacao = 'NOME:SÂMARA MORENO'`.
  Ou seja, foi materializada pelo processo de **unificação por NOME**, que gravou o nome
  abreviado e a matrícula 12370. `alunos_unificados` confirma o mesmo nome abreviado.
- A linha em `casos` (matrícula 12876, nome completo, `nome_referencia` em caixa alta)
  veio da **importação do caso/acordo** (mesmo dia, 23 min depois), com o nome oficial
  completo.
- Como as duas cargas usaram grafias de nome e números de matrícula diferentes para a
  mesma pessoa (mesmo CPF), o CRM passou a exibir dois pares nome+matrícula divergentes.
- **Importante:** o `aluno_id` foi corretamente compartilhado entre as duas linhas, por
  isso a ficha e o financeiro nunca "quebraram" — a divergência é **cadastral/exibição**,
  não de vínculo.

## 4. Impacto real (busca / ficha / saldo / acordos / pagamentos)

Comportamento verificado a partir de `public.buscar_aluno` / `buscar_aluno_por_id`
(definições lidas direto no banco) e do frontend (`src/pages/Aluno.jsx`, `src/pages/CRM.jsx`):

- **Ficha:** abre por `alunos.id` (UUID) via `buscar_aluno_por_id`; CRM navega por
  `casos.aluno_id`. Como o `aluno_id` é o mesmo, **a ficha funciona normalmente**.
- **Saldo / acordos / parcelas:** tudo lido por `aluno_id` — **íntegro e correto**.
- **Busca por CPF:** funciona (ramo `cpf ILIKE %dígitos%`).
- **Busca por nome abreviado** "Sâmara Moreno": funciona (substring contígua em
  `nome_normalizado = 'samara moreno'`).
- **Busca por nome completo** "Sâmara Paola Ennes Moreno": o RPC retorna vazio (não é
  substring contígua de "samara moreno"); só é encontrada pelo *fallback* multi-token do
  frontend. Buscar isoladamente "Paola" ou "Ennes" **não** encontra o aluno.
- **Busca por matrícula:** `buscar_aluno` **não tem ramo de matrícula** (é decisão global
  de design). Logo, nem 12370 nem 12876 encontram o aluno pela busca oficial. No CRM, o
  filtro local sobre `casos` acha 12876 (não 12370).
- **Fidelização / ações massivas** (`internal.matricula_em_fidelizacao`): usam matrícula
  **apenas** como fallback quando `casos.aluno_id` é NULL. Aqui o `aluno_id` está
  preenchido, então essas regras usam o `aluno_id` e **não são afetadas** pela matrícula.

### Tabelas afetadas pela divergência (cadastral)
Somente `alunos` e `casos`. `alunos_unificados` é consistente com `alunos`. Nenhuma
tabela financeira é afetada.

## 5. Valores canônicos

| Campo | Valor canônico | Situação |
|-------|----------------|----------|
| `aluno_id` | `7a7460b8-8550-4583-bfea-9ea4e5e5a0fa` | **Definitivo** |
| CPF | `01046168142` | **Definitivo** |
| Matrícula | **INDETERMINADO** (12370 × 12876) | Requer confirmação manual |
| Nome | **INDETERMINADO** (abreviado × completo) | Requer confirmação manual |

## 6. Por que a matrícula/nome NÃO foi alterada automaticamente

Regra do playbook: corrigir **apenas** campos *comprovadamente* incorretos e parar diante
de qualquer ambiguidade. A partir dos dados do CRM **não é possível provar** qual matrícula
é a correta, porque há dois cenários indistinguíveis sem a verdade do sistema acadêmico:

1. Uma matrícula correta + uma errada (erro de digitação/importação); **ou**
2. Duas matrículas **legítimas** da mesma pessoa (rematrícula / segundo vínculo).

No cenário (2), sobrescrever uma matrícula **destruiria dado válido**. Por isso, seguindo
as regras 7 e 8 (parar em ambiguidade; nunca alterar dado sem necessidade), **nenhum campo
cadastral ou financeiro foi mutado**. A escolha do valor canônico é uma decisão de negócio
(conferência no sistema acadêmico), não uma inferência de dados.

## 7. Correção preparada (reversível, auditada, NÃO aplicada)

O arquivo [`scripts/reconciliacao/samara_moreno_reconciliacao.sql`](../../scripts/reconciliacao/samara_moreno_reconciliacao.sql)
contém a correção cirúrgica **pronta para execução manual após a confirmação** do valor
canônico. Ele **não** está em `supabase/migrations/` de propósito, para **não** ser
auto-aplicado por deploy/CI. Características:

- **Backup** das linhas de `alunos` e `casos` antes de qualquer mudança
  (`bkp_reconc_samara_YYYYMMDD`).
- Atualiza **somente** campos cadastrais de exibição/busca (`nome`, `nome_normalizado`,
  e — se confirmado — `matricula`). **Nunca** toca em `cpf`, `aluno_id`, acordos,
  parcelas, pagamentos, responsáveis, carteira, fidelização ou status financeiro.
- Preserva a matrícula secundária (não exclui) quando o cenário for de rematrícula.
- Registra **auditoria** (`public.auditoria`).
- Inclui **rollback** completo a partir do backup.
- Guarda de segurança (`v_confirmado`) que **aborta** por padrão até a operadora
  preencher o valor canônico confirmado.

## 8. Riscos encontrados

1. **Ambiguidade de matrícula** (principal): sem o sistema acadêmico não se prova qual das
   duas é a válida, ou se ambas são. Decisão manual obrigatória.
2. Alterar `nome_normalizado` para o nome completo **quebraria** o match contíguo do nome
   abreviado no RPC (só o fallback do frontend acharia). O script trata isso mantendo os
   dois nomes pesquisáveis quando possível.
3. Busca por matrícula é limitação **global** do `buscar_aluno` (sem ramo de matrícula) —
   fora do escopo desta reconciliação de 1 aluno; registrado como observação.
4. Higiene do repositório: existem vários arquivos `*.backup-*` em `src/` com lógicas de
   busca antigas divergentes — ruído de manutenção (não alterado aqui).
5. Segurança (não relacionado ao caso): 7 tabelas de backup estão com RLS desabilitado
   (aviso do Supabase). Fora do escopo; reportado à parte.
