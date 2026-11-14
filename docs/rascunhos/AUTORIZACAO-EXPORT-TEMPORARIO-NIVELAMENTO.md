# Solicitação de autorização — acesso temporário de leitura para o export do nivelamento V2

**Pedido:** um administrador do projeto Supabase cria, por um tempo limitado, um papel de leitura
com privilégios mínimos, para uma única extração de metadados (definições de função e DDL de tabela).
**Não** inclui dados de tabelas, credenciais de usuários, nem a senha do papel `postgres`.

**Status deste documento:** solicitação. Nada foi criado. Integração com produção: **pendente**.

## 1. Privilégios mínimos (já testados no CI, Postgres 16 sintético)

O papel `leitor_defs` recebe apenas:
- `CONNECT` no banco `postgres`;
- `USAGE` nos schemas `public` e `internal`.

Não recebe `SELECT`, `INSERT`, `UPDATE`, `DELETE`, nem `CREATE`, nem `EXECUTE` em funções, nem superuser, nem createdb/createrole.
A consulta de export lê apenas catálogos do sistema (`pg_proc`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_type`, `pg_enum`), que são legíveis por qualquer papel.
No teste do CI, o papel sem `SELECT` em tabelas recebeu `permission denied` ao tentar ler `public.casos`.

## 2. Criação do papel (feita pelo administrador, no SQL Editor, como dono do projeto)

Não usar a string de conexão de Settings → Database, que é do papel `postgres`.
A senha é gerada pelo próprio administrador e **não** deve ser enviada a ninguém no chat, em logs ou no repositório.

```sql
create role leitor_defs login password '<gerada pelo administrador>'
  nosuperuser nocreatedb nocreaterole noinherit connection limit 2;
alter role leitor_defs set default_transaction_read_only = on;
grant connect on database postgres to leitor_defs;
grant usage on schema public to leitor_defs;
grant usage on schema internal to leitor_defs;
```

Validade sugerida: **uma hora**, com revogação ao final (seção 5).

## 3. Configuração no terminal de quem extrai (não no repositório)

- Driver já instalado em diretório isolado (sem alterar o projeto nem o lockfile): `~/pgdrv/node_modules/pg/lib/index.js`.
  Se ele não existir na máquina, instalar apenas lá: `mkdir -p ~/pgdrv && cd ~/pgdrv && npm init -y && npm install --silent pg@8`.
- A URL de conexão do papel é definida só na sessão do terminal, sem ser impressa:
  `export PROD_READONLY_URL='<url do papel leitor_defs>'`
- Caminho do driver:
  `export PG_DRIVER="$HOME/pgdrv/node_modules/pg/lib/index.js"`

## 4. Procedimento de extração e conferência

Comandos separados, na raiz do repositório, na branch `feat/nivelamento-v2` (commit `3abce434` ou posterior):

```bash
cd <raiz do repositório>
```

```bash
node supabase/tests/nivelamento_v2/extrair_prod_defs.mjs
```

O extrator grava em arquivo temporário, confere os sha256 de cada item e varre segredos. Só substitui `supabase/tests/nivelamento_v2/prod_defs.json` se tudo passar. Em qualquer falha, o arquivo anterior fica intacto.

Conferência adicional do arquivo (sem abri-lo para revisão manual):

```bash
node supabase/tests/nivelamento_v2/importar_prod_defs.mjs supabase/tests/nivelamento_v2/prod_defs.json /tmp/conferencia_prod.sql
```

Depois, o arquivo `prod_defs.json` é commitado **somente após** a aprovação da etapa de integração.

## 5. Revogação e remoção

Após a extração, no SQL Editor:

```sql
revoke connect on database postgres from leitor_defs;
drop role leitor_defs;
```

E, no terminal: `unset PROD_READONLY_URL`.

## 6. Conteúdo do export e risco de segredos

Verificado em produção, somente leitura, sobre o fechamento de 25 funções:
- nenhuma função com padrão de JWT, chave `sk_live`/`sk_test`, ou palavra `password`/`senha`/`secret`/`api key`;
- nenhuma função com SQL dinâmico (`EXECUTE`/`format`), o que confirma que o fechamento é completo por análise de texto.

A checagem automática (importador) é **complementar, não garantia absoluta**: varre também DDL de tabelas e tipos, mas não cobre todo formato de segredo. Se o arquivo real trouxer algum padrão suspeito, o extrator recusa e nada é gravado.

## 7. Pendências declaradas

- Export real de produção: pendente.
- Integração e rollback com as definições reais: pendentes.
- Aprovação final do nivelamento: pendente. Nada aplicado em produção, nada mesclado.
