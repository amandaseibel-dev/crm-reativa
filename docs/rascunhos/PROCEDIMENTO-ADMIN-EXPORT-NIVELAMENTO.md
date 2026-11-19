# Procedimento do administrador — export de definições para o nivelamento V2

**Estados que devem ser diferenciados**
- **Nivelamento não aplicado:** é o estado atual e continua assim até aprovação. Esta etapa não aplica nada em produção.
- **Papel temporário criado em produção:** é o que este procedimento cria, sob autorização específica. Não altera dados operacionais. Termina sempre com a remoção do papel (passo 5), mesmo se a extração falhar.

**Pré-requisitos locais (do administrador)**
- `psql` instalado.
- Conexão do dono do projeto configurada **localmente**, sem senha na linha de comando. Use `~/.pgpass` (permissão 600) ou um service file do libpq (`~/.pg_service.conf`). A URL com senha **não** vai em comando, em `-c`, nem em `-v`.
- Repositório na branch `feat/nivelamento-v2`, commit `1a9acafd` ou posterior, em worktree próprio.

Ambiente de referência do administrador, sem valores: `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` configurados no service file ou no `.pgpass`.

## Passo 1 — criar o papel temporário (produção)
```bash
psql -X -v ON_ERROR_STOP=1 -v banco=postgres -d postgres -f supabase/tests/nivelamento_v2/papel_temporario_criar.sql
```
Falha se o papel já existir (nada é criado pela metade).

## Passo 2 — definir a senha (interativo, sem registrar)
Abrir uma sessão interativa, sem senha na linha de comando:
```bash
psql -X -d postgres
```
Dentro do psql, digitar exatamente:
```
\password leitor_defs
```
O psql pede a senha duas vezes. A senha não vai para o SQL, o histórico nem os argumentos do processo. Sair com `\q`.

## Passo 3 — extrair (somente leitura)
A URL do papel `leitor_defs` fica em arquivo local com permissão 600, fora do repositório, e é carregada só na sessão:
```bash
export PROD_READONLY_URL="$(cat ~/.config/reativa/leitor_defs.url)"
```
```bash
export PG_DRIVER="$HOME/pgdrv/node_modules/pg/lib/index.js"
```
```bash
node supabase/tests/nivelamento_v2/extrair_prod_defs.mjs
```
O extrator grava em arquivo temporário, confere os hashes e varre segredos. Só substitui `supabase/tests/nivelamento_v2/prod_defs.json` se tudo passar. Em falha, o arquivo anterior fica intacto e o código de saída é diferente de zero.

## Passo 4 — revisar e enviar
Revisar `supabase/tests/nivelamento_v2/prod_defs.json` (definições e DDL, sem dados). Enviar **somente** esse arquivo. Não enviar a URL, a senha, o `.pgpass` nem o service file.

## Passo 5 — remover o papel (obrigatório, inclusive se o passo 3 falhar)
```bash
psql -X -v ON_ERROR_STOP=1 -v banco=postgres -d postgres -f supabase/tests/nivelamento_v2/papel_temporario_remover.sql
```
O script bloqueia logins, encerra sessões do papel, revoga `CONNECT` e `USAGE` em `public` e `internal`, confere dependências (`pg_shdepend`) e só então faz `DROP ROLE` simples. Se restar posse de objeto ou privilégio, ele **para** e não remove: avisar antes de qualquer ação manual.

Depois do passo 5, conferir que o papel não existe:
```bash
psql -X -At -d postgres -c "select count(*) from pg_roles where rolname = 'leitor_defs'"
```
O resultado deve ser `0`.

## Validação
- Os scripts de criação e remoção foram testados no CI (Postgres 16 sintético, job `extrator-prod-defs`), incluindo o ciclo criar → usar → remover.
- O passo 2 (`\password`) é interativo. Não é automatizável no CI sem terminal, por isso não foi testado de ponta a ponta. É o único passo sem teste automatizado.
- Os passos 3 e 5 de falha foram testados no CI: falha de conexão, divergência de hash, sem URL e remoção sempre executada.

## Pendências após a execução
- Recebimento do `prod_defs.json` revisado.
- Integração, rollback e smoke com o export real.
- Aprovação final do nivelamento. Nada aplicado em produção.
