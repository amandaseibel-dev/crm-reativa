# Correção de duplicidade — primeira aluna do lote do borderô 723 (09/10/2026)

> **Sem dado pessoal neste documento.** O repositório é público e a §7 de
> [`PREMISSA_SEGURANCA_PROJETO.md`](seguranca/PREMISSA_SEGURANCA_PROJETO.md)
> manda mascarar CPF e não registrá-lo. As fichas aparecem por `id` (uuid
> interno); o de/para com nome e CPF está nas tabelas `_backup_*`, com RLS
> deny-all e sem grant.

**Estado: aplicado em produção** (`ahattpqrjmhkzsmnbdzs`) em 09/10/2026, versão
registrada **`20261009175832`**. Arquivo em
`supabase/migrations/20261009175832_apagar_fichas_duplicadas_vazias_lote_bordero723.sql`,
rollback ao lado em `supabase/rollbacks/`.

## O que havia

Seis fichas para o mesmo CPF, todas criadas no **mesmo lote de importação** em 08/10/2026 19:18:51 (`importacao_id 817bb231`). Nenhuma delas
tinha caso — a aluna não estava em fila por caso, e sim pela rota de
mensalidades/ação massiva.

| ficha | saldo | conteúdo |
|---|---|---|
| **c4c8781e** (fica) | **R$ 10.445,07** | 6 títulos em aberto (doc 4019901–4019906, venc. 01–06/2026), 5 movimentações (ação massiva de 09/10 + atendimento da Nataly), 1 solicitação financeira aberta ("Tem fies?", `ENVIADO_FINANCEIRO`), responsável `cobranca08` |
| d170ac1e, 22ba5dd1, bf707bb4, 78c350d1, 468768c2 | saldo nulo / R$ 0,00 | nada: sem caso, acordo, título, pagamento, contato, atendimento ou confirmação. Única referência em toda a base: `elegibilidade_shadow_divergencia` (15 linhas, `SALDO_ZERO_DEFINITIVO`, `saldo_diagnostico` 0,00) |

Censo feito por varredura de **todas as tabelas BASE de `public` com coluna
`aluno_id`**, não por amostra.

## Decisão

`docs/PADRAO_CADASTRO.md` (regra 5 e 6) e o cabeçalho de
`20260827250000_mesclar_aluno_duplicado.sql` proíbem apagar ficha **com
conteúdo** — foi o que gerou os 761 casos sem aluno de 27/08. A Amanda
autorizou a exclusão em 09/10/2026, com o limite explícito: *"se tiver cadastro
duplicado podemos sim apagar"*, *"não podemos apagar alunos com dívida"*.

A migration implementa esse limite como **portão**, não como cuidado de quem
escreveu: aborta a transação inteira se qualquer ficha da lista tiver saldo,
valor em aberto, caso, acordo, título, pagamento ou **uma única linha em
qualquer tabela viva** com `aluno_id`.

## Resultado conferido (leitura pós-execução)

- fichas para o CPF: **1** (`c4c8781e`) — o nome aparece 1× na busca
- `saldo_total`: **10.445,07** — idêntico ao de antes
- títulos: **6**, soma **10.445,07**; títulos órfãos (sem aluno): **0**
- movimentações: **5**; solicitação financeira aberta: **1** (intacta)
- casos: 0 antes, 0 depois
- `audit_log`: exatamente **5** linhas `alunos/DELETE`, com os 5 ids esperados
- backups: `_backup_alunos_dup_thamis_20261009` (6 fichas) e
  `_backup_shadow_dup_thamis_20261009` (15 linhas), ambas com RLS deny-all
  (`enable` + `force`) e sem grant a `anon`/`authenticated`

Nenhum outro CPF foi tocado: a exclusão filtra por id **e** CPF.

## Débito que fica aberto

A causa não foi corrigida: **a importação de 08/10 criou 6 fichas para o mesmo
CPF no mesmo lote**. O índice único em `alunos.cpf_limpo` continua bloqueado
(ver `PADRAO_CADASTRO.md`, "O que ainda bloqueia"). Enquanto a importação puder
repetir isso, o caso volta — vale varrer os outros CPFs do lote `817bb231`.

Medido em 09/10/2026, no mesmo minuto de importação (08/10 19:18), já sem esta
aluna: **14 CPFs com mais de uma ficha, 33 fichas envolvidas**. A causa no
importador e a proposta de consolidação desses 14 estão em
[`IMPORTADOR-CADASTRO-UNICO-POR-CPF-2026-10-09.md`](IMPORTADOR-CADASTRO-UNICO-POR-CPF-2026-10-09.md).

## Pendência registrada

As duas tabelas de backup criadas aqui carregam um primeiro nome
(`_backup_alunos_dup_thamis_20261009`, `_backup_shadow_dup_thamis_20261009`).
Elas já existem em produção com esse nome e o rollback depende dele: renomear é
alteração de produção e precisa de autorização própria.
