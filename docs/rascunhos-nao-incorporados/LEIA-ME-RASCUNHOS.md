> # ESTES ARQUIVOS NÃO FORAM INCORPORADOS AO LEDGER
>
> **Nada neste diretório é registro oficial.** São rascunhos históricos,
> preservados por decisão da gestão em 27/10/2026, e **recusados** para entrada
> no ledger.

## Por que foram recusados

Eles registrariam a revogação emergencial de EXECUTE de PUBLIC em cinco funções
do encerramento, aplicada em produção em **27/10/2026 15:25 UTC** por
`execute_sql`, fora de qualquer migration.

O formato do ledger **não acomoda esse caso**. Três dos nove campos do
`INDICE.tsv` derivam de `supabase_migrations.schema_migrations`:

| Campo | De onde vem | No nosso caso |
|---|---|---|
| `version` | a versão que produção gravou | **não existe** |
| `md5` | md5 dos `statements` (`RUNBOOK-MIGRATIONS.md` §7) | **não existe** |
| `bytes` | tamanho dos `statements` | **não existe** |

Confirmado em leitura: **zero versões com prefixo `20261027`** em
`schema_migrations`; a mais recente do histórico é `20261026231529`, de 26/10.
`execute_sql` não registra versão — só `apply_migration` e `db push` registram.

A regra 3 do `supabase/ledger/LEIA-ME.md` contempla entradas **sem arquivo**
(`arquivo = -`, para execuções pontuais e sondas), e não entradas **sem versão**.
E a escrita manual em `schema_migrations` é **vetada** pelo
`supabase/ledger/DUAS-TRILHAS.md`.

Preencher aqueles três campos seria invenção, e comprometeria a cadeia byte a
byte que é o único valor do ledger.

## Dois defeitos conhecidos destes rascunhos

Preservados sem correção, por determinação da gestão. Quem os reaproveitar
precisa consertar os dois:

1. **`version` é pseudo-versão inventada** (`20261027152500`, derivada do
   horário UTC da execução). Não corresponde a nada em `schema_migrations`.
2. **`tipo` está errado.** O rascunho diz `EXECUCAO_PONTUAL`, que o `LEIA-ME`
   define como "rodou uma rotina para capturar resultado" e que **não pode** ter
   par em `migrations/`. O tipo correto seria `ESTRUTURAL`, que cobre
   "cria ou altera tabela, função, gatilho, índice, política, **permissão**" e
   **pode** ter par.

## Onde está a evidência oficial

**`docs/seguranca/RELATORIO-P0-REVOKE-ENCERRAMENTO-2026-10-27.md`** — evidência
oficial da execução, por decisão da gestão. Traz executor, horário, ACLs antes e
depois por `aclexplode`, as cinco sondas HTTP antes e depois, e a validação dos
perfis autorizados.

O `RUNBOOK-MIGRATIONS.md` §7 já previa esta situação: *"O ledger não é portão: a
catraca não reprova por falta de linha. O registro é obrigação de processo, não
dependência técnica — e já houve versão aplicada em produção sem registro por
isso."* A ausência da linha é dívida de processo. O acesso está fechado e
validado.

## Conteúdo

| Arquivo | O que é |
|---|---|
| `INDICE-linha-nova.tsv` | linha de 9 campos que **não** foi apendada ao `INDICE.tsv` |
| `nota-que-acompanharia.md` | nota explicativa que acompanharia a linha |
| `sql-executado-27-10-2026.sql` | o SQL exato que rodou — md5 `9b12ed43d8a865bbdba6bc91ba4e4666`, 575 bytes |

## Terceiro defeito: os nomes, já corrigidos

Os arquivos nasceram com o prefixo de 14 dígitos e o `__` duplo, imitando a
convenção da trilha B. Dois problemas: `scripts/ci/catraca-migrations.mjs`
reprovaria o `.sql` com **M7-FORA-DE-MIGRATIONS**, porque arquivo começando com
14 dígitos fora de diretório auxiliar é barrado; e copiá-los para
`supabase/ledger/2026-10/` passaria sem reclamação, o que é o risco que esta
marcação existe para evitar.

**Renomeados em 27/10/2026, conteúdo intacto** — o md5 do `.sql` segue
`9b12ed43d8a865bbdba6bc91ba4e4666`, conferido depois da renomeação. O diretório
também saiu de `para-o-ledger` para `rascunhos-nao-incorporados`, porque o nome
anterior descrevia um destino que a gestão recusou.

O `.sql` tem valor próprio como registro do texto executado, independentemente
do ledger.
