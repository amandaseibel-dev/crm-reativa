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

**Conferência posterior, na própria transação** (se algo sair do alvo, não
comita):

| Checagem | Esperado |
|---|---|
| (a) tabelas com TRUNCATE para `authenticated` | **0** |
| (b) ACL de `authenticated` exatamente `arwdxtm` | **545** |
| (c) tabelas com RLS desligada | **0** — esta migration não toca RLS |
| (d) tabelas fora do padrão sem TRUNCATE | informativo, não bloqueia |

Mais a conferência manual pós-commit, comentada no fim do arquivo.

**Rollback baseado nos grants originais.** Mesma lista, `grant truncate`,
devolvendo `arwdDxtm`. Como o revoke retira **só** o `D` e as 545 tinham ACL
idêntico, devolver o `D` recompõe o original letra por letra — não é
aproximação. As três tabelas sem grant seguem fora: concedê-las seria
**ampliar** acesso, não reverter.

---

## 7. Teste: o que foi provado e o que não foi

### 7.1 O que não deu para fazer

**O teste em staging não rodou.** O MCP do Supabase desta sessão está escopado
**só na produção**: qualquer consulta ao projeto `edlzlfbstshojxrudwaa`
devolve `You do not have permission to perform this action` — inclusive um
`select current_database()`. Não há, nesta sessão, ambiente isolado alcançável.

As duas saídas para um teste isolado de verdade, **nenhuma executada**:

1. **Supabase local** (`supabase start`) — a máquina tem 8 GB com swap
   saturado; subir o stack é risco operacional real, não só custo.
2. **Branch do Supabase** — **tem custo em dinheiro** e exige aviso prévio à
   gestão (regra da casa). Além disso, as `_backup_pos_import_*` não existem
   numa branch nova, então o teste teria de recriar a condição à mão.

### 7.2 O que foi provado, e como

Ensaio **atômico** em produção: um único `DO` block que executa o revoke
equivalente, roda todas as conferências, executa o grant do rollback e
**termina levantando exceção de propósito**. Como um `DO` block é uma única
instrução, a exceção desfaz tudo — nada persistiu. **Nenhum TRUNCATE foi
executado**, conforme instruído.

| # | Checagem | Resultado |
|---|---|---|
| 1 | alvo antes | **545 tabelas**, md5 `e9368e7cd2d8095423234387ace01018` |
| 2 | com TRUNCATE depois do revoke | **0** (esperado 0) |
| 3 | ACL `authenticated=arwdxtm` | **545** (esperado 545) |
| 4 | RLS desligada | **0** (esperado 0) |
| 5 | tabelas fora do padrão sem TRUNCATE | 357 — **pré-existente**, não efeito do ensaio |
| 6 | mantêm os outros 6 privilégios (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REFERENCES`, `TRIGGER`) | **545** (esperado 545) |
| 7 | ACL restaurado a `arwdDxtm` pelo rollback | **545** (esperado 545) |

**Conferência de que nada persistiu**, depois do ensaio:
545 com TRUNCATE, 548 no total, 548 com RLS — produção exatamente como antes.

Isso prova: a sintaxe roda, o revoke acerta o alvo, **não** respinga em outro
privilégio, **não** toca RLS, e o rollback restaura o ACL original. A forma do
predicado de ACL usada nos arquivos é a que passou no ensaio.

### 7.3 O que segue NÃO COMPROVADO

- **Que `TRUNCATE` ignora RLS não foi demonstrado por execução** — é
  comportamento documentado do Postgres (RLS cobre `SELECT`/`INSERT`/`UPDATE`/
  `DELETE`; `TRUNCATE` é governado por privilégio). A gestão proibiu executar
  TRUNCATE em produção, e não havia ambiente isolado. **Fica como premissa
  documental, não como medição.**
- **Gate automático de segurança não rodou:** `scripts/seguranca/run_security_gate.sh`
  exige `psql`, **que não está instalado nesta máquina**. Sem o gate, o
  resultado é NÃO COMPROVADO — não "passou".
- **Matriz de perfis (§9) não aplicável nesta mudança**, e não foi executada:
  não há RLS, policy, RPC, view ou dado pessoal alterado. Vai como
  **NÃO CONFERIDO**, não como ☑.

---

## 8. Checklist de deploy (`CHECKLIST_SEGURANCA_DEPLOY.md`)

**A. Gate automático** — `auditoria_seguranca.sql` **NÃO EXECUTADO** (`psql`
ausente). Resultado: **NÃO COMPROVADO**.

**B. Critérios de interrupção** — nenhum disparado por esta mudança: não
desliga RLS, não torna bucket público, **não concede** nada a
`public`/`anon`/`authenticated` (só **retira**), não cria RPC nem view, não
altera mascaramento. `service_role` não entra no bundle. Nenhuma referência a
staging. **Alterações operacionais inesperadas: 0** (ensaio desfeito, produção
conferida).

**C. Migration** — sem `CREATE OR REPLACE`: nenhuma função, view, trigger,
tabela ou policy é criada ou substituída, então não há grants nem `search_path`
a restaurar. Rollback preparado e testado no ensaio. ☑

**D. Teste de perfis (com ROLLBACK)** — **NÃO CONFERIDO**, por não se aplicar:
nenhuma regra de acesso de operador, carteira, RPC ou view muda. O único papel
afetado é `authenticated`, e o efeito é **perda** de um privilégio que nenhuma
tela usa.

**E. Dados pessoais / Storage** — **não se aplica**: nenhum dado, coluna,
bucket, URL assinada ou log é tocado.

**F. Conclusão (§13)**

```
SEGURANÇA VALIDADA: [x] (por auditoria de catálogo + ensaio atômico)
PERFIS TESTADOS: [ ] NÃO CONFERIDO -- não se aplica (nenhuma regra de acesso muda)
RLS VALIDADA: [x] (548/548 seguem com RLS ligada; a migration não toca RLS)
GRANTS VALIDADOS: [x] (545 alvo, 3 fora, PUBLIC ausente, service_role mantido)
RPCS VALIDADAS: [x] (nenhuma executa TRUNCATE; acordos_pos_importacao é SECURITY DEFINER e não depende do grant)
PII MASCARADA: [ ] não se aplica (nenhum dado pessoal no escopo)
ARQUIVOS PRIVADOS: [ ] não se aplica (nenhum bucket no escopo)
ALTERAÇÕES OPERACIONAIS INESPERADAS: 0
ROLLBACK PREPARADO: [x] (lista explícita, grants originais, testado no ensaio)
GATE AUTOMÁTICO: [ ] NÃO COMPROVADO -- psql ausente nesta máquina
RESULTADO: [x] ☑ APROVADO PARA APLICAÇÃO -- condicionado a: (1) autorização
           explícita da gestão para aplicar, (2) executor único = sessão
           principal, (3) backup/rollback à mão porque PITR está desligado
```

---

## 9. O que falta decidir

1. **Aplicar ou não** o revoke em produção. Preparado; não aplicado.
2. **Item 4 do §5** — fechar a porta que recria o grant
   (`acordos_pos_importacao`). É o que impede o problema de voltar.
3. **Item 3 do §5** — `alter default privileges` no schema `public`. Decisão
   maior, frente própria.
4. **Teste isolado de verdade**, se a gestão quiser antes de aplicar: exige
   Supabase local (risco na máquina de 8 GB) ou branch do Supabase (**custo em
   dinheiro**, precisa de aviso e aprovação).
5. **Gate automático** — instalar `psql` nesta máquina é pré-requisito para
   qualquer entrega sensível sair com gate comprovado, não só esta.
