# REVOKE de TRUNCATE nas tabelas `_backup_pos_import_*`

**Data:** 07/11/2026 · **Autorização da gestão:** 07/11/2026
**Ambiente medido:** PRODUÇÃO `ahattpqrjmhkzsmnbdzs` (confirmado por
`plugins/reativa-one/scripts/ambiente.sh`; `config.toml` aponta staging e é
identificador **local**, não destino)
**Estado:** **PREPARADO, NÃO APLICADO.** Nenhuma alteração persistiu em
produção. Nenhum TRUNCATE foi executado em produção.

Arquivos desta entrega:

| Arquivo | O que é |
|---|---|
| `supabase/aguardando_aprovacao/20261107200000_revoke_truncate_backup_pos_import.sql.pendente` | migration, lista explícita de 545 tabelas, duas guardas e conferência na própria transação |
| `supabase/aguardando_aprovacao/20261107200000_revoke_truncate_backup_pos_import.rollback.sql` | rollback pela mesma lista, baseado nos grants originais medidos |
| este documento | evidência, diferenciação SQL × API, acesso equivalente e bloco §13 |

---

## 1. O risco, em uma frase

As 548 tabelas `_backup_pos_import_*` têm **RLS habilitada e zero policy** — o
que bloqueia leitura e escrita linha a linha — mas **`TRUNCATE` não passa por
RLS**: é governado só pelo privilégio de tabela. Com `TRUNCATE` concedido a
`authenticated`, as 11.645 linhas de lastro de desfazer de ação financeira
guardadas em 335 dessas tabelas estão esvaziáveis por privilégio, e **PITR não
está habilitado** neste projeto.

---

## 2. Privilégios efetivos confirmados (somente leitura, 07/11/2026)

Fonte: `aclexplode(pg_class.relacl)`, `has_table_privilege`, `pg_auth_members`,
`pg_roles`, `pg_default_acl`.

### 2.1 Quem tem o quê nas 548

| Papel | TRUNCATE | Observação |
|---|---|---|
| `authenticated` | **545 de 548** | `arwdDxtm` — o `D` é TRUNCATE |
| `anon` | **0** | não aparece em nenhum ACL das 548 |
| `PUBLIC` | **0** | **nenhum grant a PUBLIC em nenhuma das 548** (`aclexplode` com `grantee = 0` não retorna linha) |
| `service_role` | 548 | **mantido de propósito** — papel de backend/Edge Function, nunca vai ao navegador (premissa §5) |
| `postgres` (owner) | 548 | owner das 548 |
| ACL nulo | 0 tabelas | todas têm ACL explícito |

**São 545, não 548.** Três tabelas nunca receberam grant a `authenticated` e
ficam fora porque não há o que revogar nelas:
`_backup_pos_import_20260831225215`, `_backup_pos_import_20260831232000`,
`_backup_pos_import_20260901085846` — nelas o ACL é só `postgres` +
`service_role`.

> Isto corrige o diagnóstico anterior, que falava em "548 de 548".

**ACL idêntico nas 545**, letra por letra, sem exceção:
`postgres=arwdDxtm/postgres | authenticated=arwdDxtm/postgres | service_role=arwdDxtm/postgres`
— é o que torna o rollback exato, e não aproximado.

### 2.2 Herança de papéis

| Membro | É membro de | `inherit` | Consequência |
|---|---|---|---|
| `authenticator` | anon, authenticated, service_role | **false** | precisa de `set role` explícito; é o papel que o PostgREST usa para conectar, com **senha de banco**, não com JWT |
| `postgres` | anon, authenticated, service_role | **true** | `bypassrls=true` — quem tem `postgres` tem tudo, revoke ou não |

`authenticated`, `anon` e `service_role` são **NOLOGIN**: não existe conexão
direta com esses papéis.

### 2.3 Origem do grant — e por que ele volta

Default privileges do schema `public`:

```
postgres       -> r :: postgres=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
supabase_admin -> r :: postgres=arwdDxtm | anon=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
```

Toda tabela criada em `public` **nasce** com `arwdDxtm` para `authenticated`.
Não houve concessão deliberada: é herança do default. Esta migration **não
altera o default** (está fora da autorização), então o item fica registrado em
§5 como ajuste proposto.

---

## 3. Rotina legítima que dependa de TRUNCATE: nenhuma

| Verificação | Resultado |
|---|---|
| Funções do schema `public` que executam TRUNCATE | **0** (varredura em `pg_proc.prosrc`) |
| Jobs do `cron` que citam TRUNCATE ou essas tabelas | **0** de 60 |
| Triggers não-internos nessas tabelas | **0** |
| FK, constraints, índices, views que dependam delas | **0** (medido na rodada anterior) |
| Funções que **leem** essas tabelas | **0** |

A única função que as cita é **`acordos_pos_importacao(p_importacao_id uuid,
p_confirmar boolean)`**, que as **cria**:

```sql
execute format('create table if not exists public.%I as ...', '_backup_pos_import_' || v_lote);
execute format('alter table public.%I enable row level security', '_backup_pos_import_' || v_lote);
```

Ela é `SECURITY DEFINER`, owner `postgres`, `search_path=public` fixo e
`statement_timeout=600s`. Roda com os privilégios do **owner**, não com os de
`authenticated` — **o revoke não a afeta.** E `v_lote` vem de
`to_char(clock_timestamp(),'YYYYMMDDHH24MISS')`, sem entrada do usuário, com
`%I`: **não há injeção por esse caminho.**

---

## 4. Privilégio SQL **não é** possibilidade de exploração pela API

A distinção que a gestão pediu, medida e não suposta:

| Caminho | Alcança TRUNCATE? | Por quê |
|---|---|---|
| REST (PostgREST) `GET/POST/PATCH/DELETE` | **Não** | PostgREST **não tem verbo TRUNCATE**. Nenhuma rota o executa |
| REST `DELETE` nessas tabelas | Não esvazia | o privilégio existe, mas RLS sem policy devolve **0 linha** |
| `/rpc/<função>` | **Não** | nenhuma função do `public` executa TRUNCATE |
| Injeção em SQL dinâmico `SECURITY INVOKER` | **Não** | a única candidata alcançável por `authenticated` é `prime_liquidacao_evidencias`, cujo dinâmico é string estática com parâmetro `$1` — não interpola entrada |
| Conexão direta ao banco como `authenticated` | **Não** | `authenticated` é NOLOGIN |
| Conexão como `authenticator` + `set role authenticated` | **Sim** | mas exige **senha do banco**, não um JWT |
| Credencial `postgres` ou `service_role` | **Sim** | por desenho; `postgres` ainda tem `bypassrls` |

**Conclusão honesta:** o privilégio está **indevidamente aberto no SQL**, e
**não há caminho conhecido de exploração pela API hoje**. O risco real é de
quem já tenha credencial de banco, de uma RPC futura que execute TRUNCATE, ou
de SQL dinâmico injetável criado depois. Fechar o privilégio é **fechar a porta
antes de existir a chave** — não é resposta a incidente, e não há aqui indício
de exploração.

Por isso **não** se aplica o §12 (resposta a incidente): não há dado
potencialmente exposto a registrar nem dever de notificação a avaliar.

---

## 5. Acesso equivalente que **continua** depois deste revoke

Registrado conforme pedido, **não corrigido aqui** — cada item exige
autorização própria:

| # | Acesso que permanece | Ajuste proposto | Por que não entra nesta PR |
|---|---|---|---|
| 1 | `service_role` com TRUNCATE nas 548 | nenhum — é por desenho | papel de backend; premissa §5 |
| 2 | `postgres` membro de `authenticated` com `inherit=true` e `bypassrls=true` | nenhum viável | quem tem `postgres` tem tudo |
| 3 | **default privilege do schema `public`** segue dando `arwdDxtm` a `authenticated` em toda tabela nova | `alter default privileges in schema public revoke truncate on tables from authenticated` | muda o comportamento de **toda** tabela futura do schema — decisão maior que a autorizada, e precisa varrer quem cria tabela em runtime |
| 4 | `acordos_pos_importacao` é `SECURITY DEFINER` com `EXECUTE` para `authenticated`: qualquer token autenticado pode chamá-la e **criar** uma `_backup_pos_import_*` nova, que nasce com TRUNCATE aberto outra vez | `revoke truncate` no final do corpo da própria função, ou tirar o `EXECUTE` de `authenticated` | é `CREATE OR REPLACE` de função — restaura grants padrão e exige reconferir grants e `search_path` (premissa §10); frente própria |

Mitigação de fato hoje para 3 e 4: o cron que gerava essas tabelas está
`active=false` e a mais recente é de **24/09/2026** — o estoque parou de
crescer. Mas a porta existe.

**Recomendação:** aprovar este revoke e abrir em seguida a frente do item 4,
que é o que impede o problema de voltar.

---

## 6. A migration, a conferência e o rollback

**Lista explícita.** As 545 tabelas estão escritas nome por nome, uma por
linha, num único `revoke truncate on table ... from authenticated`. A lista
local foi **provada idêntica** à de produção: `md5` dos 545 nomes em ordem =
`e9368e7cd2d8095423234387ace01018`, igual ao `md5` calculado pelo banco.

**Guarda 1 — conjunto.** A migration recusa rodar se o conjunto tiver mudado
(tabela nova criada depois, ou já removida): confere total `= 545` e o mesmo
`md5`, e levanta exceção com os valores encontrados.

**Guarda 2 — dependência.** Recusa rodar se qualquer função do `public` passar
a executar TRUNCATE.

**Fotografia antes de mexer.** Um bloco `DO` tira uma `_seg_antes` (temp table
`on commit drop`) com o ACL de `authenticated` e o `relrowsecurity` de **todas**
as tabelas de `public`. É contra essa fotografia que a conferência compara —
não contra string fixa, que seria presa à versão do Postgres (ver §6.1).

**Conferência posterior, na própria transação** (se algo sair do alvo, não
comita):

| Checagem | Esperado |
|---|---|
| (a) tabelas do alvo com TRUNCATE para `authenticated` | **0** |
| (b) `replace(acl_depois,'D','') = replace(acl_antes,'D','')` nas 545 | **saiu só o TRUNCATE**, nenhum outro privilégio |
| (c) `relrowsecurity` mudou em alguma tabela de `public` | **0** — não toca RLS |
| (d) tabela **fora** do padrão com ACL de `authenticated` diferente do de antes | **0** — dano colateral zero, nem em uma letra |

Mais a conferência manual pós-commit, comentada no fim do arquivo.

**Rollback baseado nos grants originais.** Mesma lista, `grant truncate`, com a
mesma régua pelo avesso: `replace(acl,'D','')` igual dos dois lados prova que
**só** o TRUNCATE voltou. Como as 545 tinham ACL idêntico e o revoke retira
apenas o `D`, devolvê-lo recompõe o original letra por letra — não é
aproximação. As três tabelas sem grant seguem fora: concedê-las seria
**ampliar** acesso, não reverter.

## 6.1 Revisão estática final (08/11/2026) — três defeitos corrigidos

A revisão linha a linha da migration e do rollback, feita **antes** de pedir
aprovação, encontrou três problemas. Todos corrigidos.

**Defeito 1 — a conferência de ACL era presa ao PostgreSQL 17.** A versão
anterior exigia a string exata `authenticated=arwdxtm/postgres`. A letra `m` é
`MAINTAIN`, que **só existe no PG17**. Produção é PG17 (o `m` aparece no ACL
medido), mas o Postgres do CI é **16** — a conferência reprovaria sozinha, por
diferença de versão, não por defeito da migration. Pior: travaria a aprovação
num falso negativo.

**Correção:** a conferência não compara mais string fixa. Um bloco novo tira
uma **fotografia** (`_seg_antes`, temp table `on commit drop`) do ACL de
`authenticated` em **todas** as tabelas de `public` antes do revoke, e a
conferência prova que

```
replace(acl_depois, 'D', '') = replace(acl_antes, 'D', '')
```

ou seja: **saiu exatamente o `D` (TRUNCATE) e mais nada** — sem depender de
versão do servidor, sem depender da ordem canônica das letras e sem supor o
nome do concedente. O rollback usa a mesma régua pelo avesso.

**Defeito 2 — a checagem de dano colateral não checava nada.** A versão
anterior contava quantas tabelas fora do padrão **não tinham** TRUNCATE e
emitia um `notice`. Isso é informação, não prova: sem um valor anterior para
comparar, o número não diz se algo mudou.

**Correção:** com a fotografia, agora é prova de verdade — nenhuma tabela fora
do padrão `_backup_pos_import_%` pode ter o ACL de `authenticated` diferente do
que era, **nem em uma letra**, ou a transação não comita. Também passou a
conferir que `relrowsecurity` não mudou em nenhuma tabela de `public`, e não
só nas 548.

**Defeito 3 (registrado, não corrigido — é limite da autorização).** A Guarda 2
recusa a migration se **qualquer** função de `public` contiver a palavra
`truncate` seguida de espaço, inclusive dentro de comentário ou string. É
conservadora: falha fechada, nunca abre. Hoje o número é zero, então não
bloqueia. Fica anotado para quem mexer depois não se surpreender.

---

## 7. Teste: o que foi provado, onde, e o que não foi

### 7.1 O que mudou desde a primeira versão

A primeira versão deste documento registrava que **não havia ambiente isolado
alcançável**. Isso estava incompleto: **o CI do repositório já oferece
PostgreSQL descartável**, no padrão que `proposta-conferido` e
`whatsapp-cadencia-continuidade` já usavam — `services: postgres:16` mais
`psql`, sem nada contratado a mais. Era o ambiente isolado, e estava à mão.

Job novo: **`revoke-truncate-backup-pos-import`** em
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), com os fixtures
em [`supabase/tests/revoke_truncate_backup_pos_import/`](../../supabase/tests/revoke_truncate_backup_pos_import/).

### 7.2 O ambiente do teste é fiel, e isso é verificado

| Fixture | O que monta |
|---|---|
| `01_ambiente.sql` | papéis `anon`, `authenticated`, `service_role` como em produção (NOLOGIN; `service_role` com `bypassrls`), e **a causa raiz**: `alter default privileges in schema public grant all on tables` — mais uma asserção que **falha o CI** se uma tabela nova não nascer com o `D` |
| `02_baseline.sql` | as **548** tabelas com os **nomes reais de produção** — 545 com grant a `authenticated`, 3 sem —, todas com RLS ligada e **zero policy**. Confere `md5 = e9368e7cd2d8095423234387ace01018` antes de prosseguir: se os nomes não forem os de produção, o CI falha |
| `03_casos.sql` | os 8 casos depois da migration |
| `04_rollback.sql` | os 3 casos depois do rollback |

### 7.3 A prova que faltava, agora feita

**`TRUNCATE` ignora RLS deixou de ser premissa documental e passou a ser
medição.** No banco descartável do CI isso pode ser executado — em produção não
podia, e não foi. O `02_baseline.sql` faz, como `authenticated`, na mesma
tabela, com RLS ligada e 0 policy:

| Operação como `authenticated` | Resultado exigido |
|---|---|
| `SELECT` | **0 linha visível** — RLS bloqueia |
| `DELETE` | **0 linha afetada** — RLS bloqueia |
| `TRUNCATE` | **esvazia a tabela** — RLS **não** protege |

Se qualquer um dos três não der esse resultado, o CI falha. É o buraco
demonstrado, não argumentado.

### 7.4 Os casos

Depois da migration (`03_casos.sql`):

| # | Caso |
|---|---|
| 1 | nenhuma das 548 tem mais TRUNCATE para `authenticated` |
| 2 | as 545 mantêm `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REFERENCES`, `TRIGGER` |
| 3 | **o mesmo TRUNCATE que funcionou no baseline agora é negado (`42501`)** e o lastro continua na tabela |
| 4 | as 3 sem grant seguem sem grant — não foram tocadas |
| 5 | 548 com RLS, 0 policy — nada mudou |
| 6 | `service_role` mantém TRUNCATE nas 548, por desenho |
| 7 | `anon` não alcança nenhuma |
| 8 | **teste negativo da guarda:** criada uma tabela nova no padrão, total e `md5` mudam — a migration recusaria rodar |

Depois do rollback (`04_rollback.sql`): 545 voltam a ter TRUNCATE, as 3 seguem
de fora, a assinatura volta a ser a de produção e a RLS continua intacta.

### 7.5 Security Gate

Passou a rodar **no CI**, contra o banco descartável, no mesmo job —
`run_security_gate.sh` com `DATABASE_URL` apontando para o serviço. Resolve a
falta de `psql` na máquina local.

**Com o escopo dito na cara:** o gate audita o **fixture**, não a produção.
Prova que a migration **não introduz achado `BLOQUEIA`** e que o gate executa.
**Não** substitui rodar o gate contra o projeto de produção.

Um achado esperado e que **não reprova**: a verificação 2 do
`auditoria_seguranca.sql` (`RLS_SEM_POLICY_COM_GRANT`) aponta essas tabelas —
RLS ligada, 0 policy, com grant a `authenticated` — e **vai continuar
apontando depois deste revoke**, porque os outros privilégios permanecem. A
gravidade é `ALERTA`, não `BLOQUEIA`, então o gate passa. O fechamento completo
seria `revoke all` de `authenticated` nessas tabelas (ninguém as lê: 0 funções,
0 views, 0 FKs) — **fora da autorização desta frente**, que é exclusivamente
TRUNCATE. Fica registrado em §9.

### 7.6 O ensaio em produção não foi repetido

Conforme instruído. O ensaio atômico de 07/11/2026 (bloco `DO` que se desfazia
por exceção) fica no histórico como registro do que foi medido naquele dia:
545 no alvo, 0 com TRUNCATE depois, RLS intacta, rollback restaurando o ACL, e
produção conferida idêntica depois. **Nada foi executado em produção em
08/11/2026** além de leitura de catálogo, e **nenhum TRUNCATE** em produção, em
nenhum momento.

### 7.7 O que segue sem teste — exatamente

1. **A migration nunca rodou contra o banco de produção.** O CI prova a
   mecânica contra 548 tabelas de mesmo nome e mesmo ACL, num Postgres **16**
   vazio. Produção é **17**, tem ~1.468 tabelas em `public`, extensões, crons e
   `pg_default_acl` de dois donos (`postgres` e `supabase_admin`). A
   equivalência é forte, mas **não é identidade**.
2. **O fixture não reproduz `authenticator` nem o PostgREST.** A conclusão de
   que não há caminho de exploração pela API vem de auditoria de catálogo e de
   leitura do código, **não** de tentativa de exploração por HTTP.
3. **O gate contra produção segue NÃO COMPROVADO.** Roda no fixture; na
   máquina local não roda por falta de `psql`.
4. **Matriz de perfis (§9 da premissa) não executada**, por não se aplicar:
   nenhuma regra de acesso de operador, carteira, RPC ou view muda.
5. **Desempenho não medido**, e esta migration não se propõe a melhorá-lo.

---

## 8. Checklist de deploy (`CHECKLIST_SEGURANCA_DEPLOY.md`)

**A. Gate automático** — roda no CI contra banco descartável (job
`revoke-truncate-backup-pos-import`). Contra **produção**: **NÃO COMPROVADO**
(`psql` ausente na máquina local). Achados `BLOQUEIA` no fixture: **0**.

**B. Critérios de interrupção** — nenhum disparado: não desliga RLS, não torna
bucket público, **não concede** nada a `public`/`anon`/`authenticated` (só
**retira**), não cria RPC nem view, não altera mascaramento. `service_role`
fora do bundle. Nenhuma referência a staging. **Alterações operacionais
inesperadas: 0** — provado por fotografia na própria transação, que aborta se
qualquer ACL fora do alvo mudar.

**C. Migration** — sem `CREATE OR REPLACE`: nenhuma função, view, trigger,
tabela ou policy criada ou substituída, então não há grants nem `search_path` a
restaurar. Rollback preparado **e testado no CI**, com conferência própria. ☑

**D. Teste de perfis (com ROLLBACK)** — **NÃO CONFERIDO**, por não se aplicar:
o único papel afetado é `authenticated`, e o efeito é **perda** de um
privilégio que nenhuma tela usa. O comportamento de `authenticated`, `anon` e
`service_role` sobre essas tabelas está coberto pelos casos 3, 6 e 7 do CI.

**E. Dados pessoais / Storage** — não se aplica: nenhum dado, coluna, bucket,
URL assinada ou log é tocado.

**F. Conclusão (§13)**

```
SEGURANÇA VALIDADA: [x] (auditoria de catálogo + 11 casos em Postgres isolado no CI)
PERFIS TESTADOS: [ ] NÃO CONFERIDO -- não se aplica (nenhuma regra de acesso muda);
                     comportamento de authenticated/anon/service_role coberto por casos 3, 6 e 7
RLS VALIDADA: [x] (548 seguem com RLS; conferido por fotografia, aborta se mudar)
GRANTS VALIDADOS: [x] (545 alvo, 3 fora, PUBLIC ausente, service_role mantido)
RPCS VALIDADAS: [x] (nenhuma executa TRUNCATE; acordos_pos_importacao é SECURITY DEFINER)
PII MASCARADA: [ ] não se aplica (nenhum dado pessoal no escopo)
ARQUIVOS PRIVADOS: [ ] não se aplica (nenhum bucket no escopo)
ALTERAÇÕES OPERACIONAIS INESPERADAS: 0
ROLLBACK PREPARADO: [x] (lista explícita, grants originais, testado no CI)
GATE AUTOMÁTICO: [x] no fixture do CI (0 BLOQUEIA) · [ ] contra PRODUÇÃO: NÃO COMPROVADO
RESULTADO: [x] ☑ APROVADO PARA APLICAÇÃO -- condicionado a: (1) autorização
           explícita da gestão para aplicar, (2) executor único = sessão
           principal, (3) backup/rollback à mão porque PITR está desligado
```

---

## 9. O que falta decidir

1. **Aplicar ou não** o revoke em produção. Preparado, testado no CI, **não
   aplicado**. É a decisão que esta entrega pede.
2. **A origem** — `acordos_pos_importacao` pode criar tabela nova com TRUNCATE
   aberto outra vez. Correção de **menor alcance** preparada em PR separada
   (ver `ACORDOS-POS-IMPORTACAO-SEM-TRUNCATE-2026-11-08.md`), também sem
   aplicar.
3. **`revoke all` nessas tabelas**, não só TRUNCATE — fecharia o `ALERTA`
   `RLS_SEM_POLICY_COM_GRANT` do gate, que este revoke **não** fecha. Ninguém
   lê essas tabelas (0 funções, 0 views, 0 FKs). Fora da autorização atual;
   decisão própria.
4. **`alter default privileges` no schema `public`** — resolveria para toda
   tabela futura, mas afeta **todas** as tabelas novas do schema. Não proposto
   aqui por alcance; precisa de varredura de quem cria tabela em runtime.
5. **Gate contra produção** — depende de `psql` na máquina ou de rodá-lo pelo
   SQL editor do projeto.
