# Migration versionada dos REVOKE — proposta e estratégia de reconciliação

**Data:** 27/10/2026 · **Branch:** `fix/cpf-ambiguo-identidade-v2`
**Estado: PROPOSTA.** A migration **não foi escrita** em `supabase/migrations/`.
**Separada da correção de CPF ambíguo**, por determinação da gestão.
**Revisão 2**, depois de REPROVAÇÃO do Guardião. O que mudou está na seção 0.

## Por que está aqui e não na pasta de migrations

`P3/migration` barra `Write`/`Edit` no diretório de migrations, e a variável do
canal da Fase 2 **não chega a esta sessão** — conferido. O caminho autorizado
pelo próprio hook é propor o SQL em documento sob `docs/`. Nada foi contornado.

---

# 0. O que a revisão 1 errava

**(a) Faltava a sexta assinatura, e a justificativa para excluí-la era falsa.**
`caso_encerrado_operacional(text,text,text,text,text)` — a de 5 argumentos — é
**`security definer`**, **não tem portão interno**, recebe **CPF por parâmetro**
e **delega para `_caso_encerrado_operacional_regra`**. Medido em produção em
27/10/2026. Como ela roda com os privilégios do dono, revogar PUBLIC da função
interna **não fecha o caminho por ela**: é oráculo equivalente por construção.

Eu a havia excluído alegando que os chamadores precisavam dela. **Errado:** os
quatro chamadores sem `security definer` (o gatilho `casos_set_encerrado_operacional`,
`preview_redistribuicao_casos`, `resumo_carteira_operador` e a view
`vw_saude_carteira`) rodam como `authenticated` ou como dono, e `authenticated`
tem grant **explícito**. Nenhum precisa de PUBLIC.

Em produção ela já está fechada — `has_function_privilege('public', …)` = false,
medido. Então incluí-la é **no-op em produção** e proteção real em qualquer outro
lugar. Agora são **seis**.

**(b) O bloco de conferência falhava ABERTO, por dois caminhos.** Era a mesma
classe de erro que já me pegou antes: uma checagem que não checa.

1. Comparava `p.oid::regprocedure::text` com strings **sem schema**. O
   `regprocedure` só omite `public.` quando `public` está visível no
   `search_path`; com outro `search_path` o `in (...)` casa zero linhas e o teste
   **passa em silêncio**.
2. `aclexplode(p.proacl)` com `proacl` **nulo** devolve zero linhas — e `proacl`
   nulo é exatamente o estado de privilégio **padrão**, que para função
   **inclui EXECUTE a PUBLIC**. O teste diria "sem PUBLIC" num caso em que
   PUBLIC executa.

Corrigido: a conferência passa a usar `has_function_privilege`, que resolve o
padrão corretamente, e `to_regprocedure` sobre nome qualificado.

3. Faltava a metade contrária: nada afirmava que `authenticated` e
   `service_role` **mantêm** EXECUTE. Um `revoke` exagerado passaria verde.
   Acrescentado.

**(c) Eu afirmei que `revoke` é idempotente. Não é, em três casos.** Função
ausente → `42883`; **papel inexistente → `42704`**, que é o caso de um Postgres
ou PGlite sem os papéis da Supabase; e executado por quem não é dono nem tem
grant option → **`WARNING` "no privileges could be revoked" e segue adiante**, ou
seja falha silenciosa. O terceiro caso é vivo aqui, porque a causa do grant a
PUBLIC segue **NÃO COMPROVADA** e o concedente pode ter sido outro papel. A
proteção contra ele é exatamente o bloco de conferência — que, antes de (b),
podia não pegar.

**(d) O Destino 2 afirmava fato não comprovado.** Dizia "sem ela, as cinco
nascem com PUBLIC". Isso depende do privilégio padrão do ambiente novo, que
**ninguém mediu**, e contradizia o §7 do relatório, que declara a causa como não
comprovada. Reescrito.

**(e) Pendências não declaradas.** A ausência de portão interno nas seis, e o
risco residual de `authenticated`, não estavam em lugar nenhum. Agora estão, na
seção 3.

---

# 0b. A causa raiz, agora COMPROVADA

Eu a declarei **duas vezes** como irrecuperável, e estava errado nas duas: a
resposta era mensurável em bancada, e barata.

Retratações anteriores, mantidas para registro: *"a trava era pretendida e saiu
inconsistente"* (sem proveniência) e *"houve omissão sistemática; o que separa as
fechadas das abertas é a idade"* (derrubada pela medição de que **325 de 508**
migrations que criam função já revogam de `public, anon`).

**A medição, em 27/10/2026.** Replicando na bancada o `pg_default_acl` de
produção para o papel `postgres` no schema `public` —
`{authenticated=X, service_role=X}`, **sem PUBLIC** —, as seis **ainda nascem com
`=X`**, e a ACL resultante é **idêntica à de produção**:
`{=X, postgres=X, authenticated=X, service_role=X}`.

**Porque `create or replace` PRESERVA a ACL existente, ignorando o privilégio
padrão.** O `=X` vem da **primeira criação** da função, sob o padrão de fábrica do
PostgreSQL — que inclui PUBLIC —, e nenhuma migration jamais o revogou. A §10 da
premissa de segurança já avisava sobre `create or replace` e grants; faltava
ligar o aviso a este caso.

Três consequências que mudam decisões:

1. **Mexer em `pg_default_acl` não conserta nada** — nem função existente, nem
   função recriada. Só `revoke` explícito fecha. Enterra de vez a proposta que eu
   já havia retirado.
2. **As seis não eram anomalia**: eram o esperado para função cuja linhagem
   começou antes de qualquer ajuste de padrão. Provavelmente explica parte das
   124 funções com PUBLIC nesta base.
3. **Ambiente novo herda o mesmo `=X`** — é o que sustenta o Destino 2.

Agravante que permanece: **não há entrada no ledger para `20261026200000`**, então
a linhagem exata daquelas funções não é rastreável pelo repositório.

Registrado no teste `T1c` de
`supabase/tests/revoke_execute_public_encerramento.test.js`.

---

# 1. A migration proposta

**Arquivo:** `20261027160000_revoke_execute_public_encerramento.sql`
**Rollback:** `supabase/rollbacks/20261027160000_revoke_execute_public_encerramento.rollback.sql`
— **já escrito em disco**, com as cinco concessões e a sexta comentada, porque
em produção ela já estava fechada e concedê-la abriria o que estava fechado.

A versão `20261027160000` é posterior a `20261026200000`, que cria as funções, e
não colide com nada: a maior versão de arquivo do repositório é `20261026200000`
e não há arquivo com prefixo `20261027`.

```sql
-- =============================================================================
-- REVOGA EXECUTE DE PUBLIC EM SEIS FUNCOES DO ENCERRAMENTO
--
-- CONTENCAO EMERGENCIAL JA APLICADA EM PRODUCAO EM 27/10/2026, 15:25 UTC
-- (12:25 America/Sao_Paulo), por `execute_sql`, FORA DE MIGRATION, com
-- autorizacao expressa da gestao e executora unica -- para CINCO das seis.
--
-- A SEXTA, caso_encerrado_operacional(text,text,text,text,text), JA ESTAVA sem
-- PUBLIC em producao antes de tudo (medido). Ela entra aqui porque e CAMINHO
-- EQUIVALENTE: `security definer`, sem portao interno, recebe CPF por parametro
-- e delega para _caso_encerrado_operacional_regra. Em producao o statement dela
-- e no-op; em ambiente novo, e o que impede o oraculo de reabrir por ela.
--
-- Em producao esta migration e NO-OP INTEIRA. Ela existe para que a propriedade
-- sobreviva em ambiente novo e na futura baseline.
--
-- NAO reaplicar em producao esperando efeito. Se um dia for aplicada la, a
-- versao que o historico gravar tera a data da aplicacao, e NAO a data em que o
-- acesso foi fechado. A data real da contencao e a de cima.
--
-- Evidencia: docs/seguranca/RELATORIO-P0-REVOKE-ENCERRAMENTO-2026-10-27.md
-- Rascunhos recusados pelo ledger: docs/rascunhos-nao-incorporados/LEIA-ME-RASCUNHOS.md
--
-- ESCOPO: so privilegio. Zero DML, zero `create or replace`, zero mudanca de
-- privilegio padrao, nenhuma outra funcao tocada. Nao aciona a §10 da premissa
-- de seguranca, que trata de `create or replace` restaurando grants.
--
-- DUAS DEPENDENCIAS DECLARADAS, porque `revoke` NAO e idempotente:
--   1. Os papeis `anon`, `authenticated` e `service_role` precisam EXISTIR.
--      `revoke ... from anon` num banco sem esse papel aborta com 42704. Em
--      PGlite eles vem de supabase/tests/fixtures/grupo_a_prod_20260918.sql.
--   2. O executor precisa ser o DONO ou ter grant option. Um `revoke` feito por
--      papel sem direito emite WARNING "no privileges could be revoked" e NAO
--      revoga nada -- falha silenciosa. O bloco de conferencia do fim e o que
--      pega isso.
--
-- ATOMICIDADE: este arquivo NAO traz `begin`/`commit`, seguindo a maioria do
-- repositorio (578 de 676 migrations). A guarda e a conferencia so valem se o
-- caminho de aplicacao envolver o arquivo numa transacao -- `apply_migration` e
-- `db push` o fazem. Aplicado statement a statement, a conferencia pode
-- reprovar DEPOIS de revogacoes parciais ja efetivadas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- GUARDA: falha fechado se alguma das seis nao existir.
-- -----------------------------------------------------------------------------

do $guarda$
declare
  v_faltam text;
begin
  select string_agg(a.sig, ', ' order by a.sig) into v_faltam
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null;

  if v_faltam is not null then
    raise exception
      'FUNCOES_AUSENTES: %. Aplique 20261026200000 antes desta migration.',
      v_faltam;
  end if;
end
$guarda$;

-- -----------------------------------------------------------------------------
-- A REVOGACAO
-- -----------------------------------------------------------------------------

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)
  from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid)
  from public, anon;

-- -----------------------------------------------------------------------------
-- CONFERENCIA, NOS DOIS SENTIDOS
--
-- Por PRIVILEGIO EFETIVO (`has_function_privilege`), nunca por `aclexplode`
-- sobre `proacl`: `proacl` NULO e o estado PADRAO, que para funcao INCLUI
-- EXECUTE a PUBLIC, e `aclexplode` de um nulo devolve zero linhas -- diria
-- "sem PUBLIC" num caso em que PUBLIC executa.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_aberto text;
  v_quebrou text;
begin
  -- (1) PUBLIC e anon NAO podem executar nenhuma das seis
  select string_agg(a.sig, ', ' order by a.sig) into v_aberto
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('public', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('anon',   to_regprocedure(a.sig), 'EXECUTE');

  if v_aberto is not null then
    raise exception
      'ACESSO_AINDA_ABERTO: PUBLIC ou anon seguem com EXECUTE em %. Se nenhum erro apareceu antes, verifique se o executor e dono ou tem grant option -- revoke sem direito emite WARNING e nao revoga.',
      v_aberto;
  end if;

  -- (2) `service_role` PRECISA manter EXECUTE nas seis
  select string_agg(a.sig, ', ' order by a.sig) into v_quebrou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where not has_function_privilege('service_role', to_regprocedure(a.sig), 'EXECUTE');

  if v_quebrou is not null then
    raise exception
      'SERVICE_ROLE_PERDIDO: service_role perdeu EXECUTE em %. A revogacao foi alem do escopo.',
      v_quebrou;
  end if;

  -- (3) `authenticated` PRECISA manter EXECUTE nas DUAS PUBLICAS, e so nelas.
  --
  -- NAO se exige `authenticated` nas quatro auxiliares: a migration seguinte,
  -- 20261027170000, as revoga DE PROPOSITO. Exigir aqui faria esta migration
  -- abortar com mensagem enganosa se fosse reaplicada depois daquela -- medido
  -- em bancada em 27/10/2026, antes de publicar.
  if not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(text,text,text,text,text)'), 'EXECUTE')
     or not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'), 'EXECUTE') then
    raise exception
      'OPERACAO_QUEBRADA: authenticated perdeu EXECUTE numa das assinaturas PUBLICAS de caso_encerrado_operacional. A operacao inteira depende delas.';
  end if;
end
$confere$;
```

---

# 2. O teste PGlite, no padrão da casa

Substitui a consulta da revisão 1, que herdava os dois furos de `aclexplode` e
olhava só cinco nomes — ficaria **verde com o caminho de 5 argumentos aberto**.

O padrão já existe em `supabase/tests/auditoria_encerramento_operacional.test.js`:
afirmar **privilégio efetivo**, nos dois sentidos, para as **seis**.

```sql
select a.sig,
       has_function_privilege('public',        to_regprocedure(a.sig), 'EXECUTE') as public_executa,
       has_function_privilege('anon',          to_regprocedure(a.sig), 'EXECUTE') as anon_executa,
       has_function_privilege('authenticated', to_regprocedure(a.sig), 'EXECUTE') as auth_executa,
       has_function_privilege('service_role',  to_regprocedure(a.sig), 'EXECUTE') as srv_executa
  from (values
    ('public._caso_sem_saldo_conferido(uuid,text)'),
    ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
    ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
    ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
    ('public.caso_encerrado_operacional(text,text,text,text,text)'),
    ('public.caso_encerramento_congelado(uuid)')
  ) as a(sig);
```

Critério: `public_executa` e `anon_executa` **false** nas seis;
`auth_executa` e `srv_executa` **true** nas seis.

**Dependência do teste:** os papéis `anon`, `authenticated` e `service_role`
precisam existir na bancada. Vêm de
`supabase/tests/fixtures/grupo_a_prod_20260918.sql` — é por isso que o
`revoke … from anon` não aborta com 42704 ali.

Isto é prova **semântica**, não casamento de texto, e tranca estas seis. A
catraca de CI segue valendo como rede ampla para funções futuras, com a
limitação de sobrecarga já declarada.

**Arquivo escrito e rodado:** `supabase/tests/revoke_execute_public_encerramento.test.js`.
Resultado em 27/10/2026: **T1 e T1b verdes** (medem que em banco novo PUBLIC e
`anon` executam as seis), **T2 vermelho** nomeando o bloqueio `P3/migration`, e
T3–T5 suspensos até a migration existir. O vermelho é verdadeiro: enquanto o
arquivo não existir, a propriedade **não** está garantida em ambiente novo.

---

# 3. Pendências nomeadas que esta frente deixa

**Nenhuma das seis tem portão interno, e todas recebem identidade por
parâmetro.** A §4 da premissa de segurança exige "identidade sempre por
`auth.email()`/`auth.uid()`, nunca por parâmetro do frontend", e o bloco B do
checklist de deploy trata "RPC com EXECUTE amplo sem autorização interna" como
item de interrupção. A revogação fecha o acesso **anônimo**; **não** cria portão.

**Risco residual, medido e até agora não declarado:** depois da revogação,
qualquer usuário **autenticado** — inclusive operador sem perfil de gestão —
ainda pode chamar as seis com CPF arbitrário e descobrir se aquele CPF está sem
dívida. É oráculo interno, de severidade menor que o anônimo, e **continua
aberto**. Fechá-lo exige portão interno, que é mudança de corpo de função e
frente própria.

**Proposta de conserto registrada em frente própria:**
[`P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md`](P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md),
com três passos de custo crescente e a medição que cada um exige antes de rodar.

Também seguem abertas, por delimitação de escopo: as três funções de encerramento
**com** portão interno continuam com PUBLIC na ACL;
`prime_portador_snapshot_estado(integer,integer)` e `acordo_saldo_residual(uuid)`
não foram investigadas.

---

# 4. Estratégia de reconciliação

## O ponto de partida medido

`supabase/ledger/DUAS-TRILHAS.md`, medição de 12/09/2026: **41** de 451 versões
de arquivo existem no histórico; **410** não; **1.197** versões aplicadas não têm
arquivo.

> A pasta é **documentação da intenção**; o histórico executável de produção
> vive em `schema_migrations`.

**Consequência dura:** nenhum ambiente novo é reproduzível a partir de
`supabase/migrations/` hoje — com ou sem esta migration.

> ## Registro expresso, por determinação da gestão
>
> **Esta migration representa uma correção JÁ REALIZADA em produção, não uma nova
> execução da contenção.** O acesso foi fechado em **27/10/2026 15:25 UTC**, por
> `execute_sql`, fora de migration. Aplicá-la em produção seria no-op e estamparia
> uma versão com data posterior ao fechamento real.
>
> Ela **exige reconciliação entre ambientes**: produção já tem o efeito; ambiente
> novo e a futura baseline não o teriam sem ela. Os três destinos abaixo são essa
> reconciliação.

## Destino 1 — produção: **não aplicar**

É no-op inteira: as cinco já foram revogadas, e a sexta já estava fechada.

Aplicar custaria uma versão em `schema_migrations` com data posterior ao
fechamento real do acesso (27/10 15:25 UTC), sugerindo contenção mais tarde do
que ocorreu. **Essa data é o fim da janela de exposição.** Ganho: nenhum.

Se a gestão decidir aplicar para aproximar as trilhas, o requisito é que a nota
da linha de ledger daquela versão diga que o efeito **antecede** a versão, com a
data real.

## Destino 2 — ambiente novo: **aplicar, e agora está MEDIDO**

A revisão 1 afirmava sem prova, e a revisão 2 recuou para um condicional. O teste
PGlite da seção 2 **mediu**, e o condicional caiu.

Rodado em 27/10/2026 contra um PostgreSQL novo (PGlite), depois de aplicar a
bancada e `20261026200000`:

| Medida | Resultado |
|---|---|
| as seis existem | **sim**, 6 de 6 |
| **PUBLIC executa as seis** | **sim, 6 de 6** |
| **`anon` alcança as seis por PUBLIC** | **sim, 6 de 6** |

**Em ambiente novo a exposição se reproduz integralmente** — e, o que torna o
resultado mais forte, **se reproduz mesmo com o `pg_default_acl` de produção
aplicado** (teste `T1c`, seção 0b). A objeção metodológica era correta: medir num
Postgres cru não valeria para um projeto Supabase. Medi com o padrão de produção
replicado, e o `=X` aparece do mesmo jeito.

Portanto: sem esta migration, um ambiente recriado nasce com o oráculo anônimo
aberto nas seis. Não é hipótese nem condicional.

Permanece honesto sobre o alcance: ela protege **estas seis**. Não impede que
outra função nova nasça exposta — isso é a catraca de CI e o passo de conferência
de ACL no runbook.

## Destino 3 — a futura baseline

É onde as duas trilhas convergem. Requisitos que esta frente acrescenta:

1. **A baseline tem de carregar o estado de ACL, não só de schema.** Nenhuma das
   trilhas registra ACL hoje: o md5 dos `statements` não a enxerga, e a revisão
   humana também não.
2. **Validação por `has_function_privilege` ou `aclexplode` contra produção**,
   por função — nunca por md5, e nunca por texto de `proacl`.
3. **Declarar sob qual papel a baseline é aplicada.** Medido em
   `pg_default_acl` em 27/10/2026, para o schema `public`: o padrão do papel
   `postgres` é `{postgres=X, authenticated=X, service_role=X}` — sem PUBLIC e
   sem `anon` —, e o do papel `supabase_admin` é
   `{postgres=X, anon=X, authenticated=X, service_role=X}`, **com `anon`
   explícito**. Função criada por `supabase_admin` nasce chamável por `anon`, e
   por concessão direta: um `revoke … from public` **não** a fecharia.

## Registros a fazer

- **Classificar esta migration em `supabase/ledger/DUAS-TRILHAS.md`**, na seção
  que já cataloga as nunca aplicadas. Sem isso ela entra na baseline como
  "pendente de aplicar", que é o oposto da intenção.
- **Os três requisitos de ACL em `docs/BACKLOG-TECNICO.md`.**
- **A ausência de portão interno nas seis** como pendência nomeada, pela §4 da
  premissa.

## Dependência de ordem com o passo de `authenticated`

A proposta irmã
([`P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md`](P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md))
revoga `authenticated` das quatro funções não públicas. Medido em bancada (teste
`R4`): **esse revoke é inócuo enquanto PUBLIC tiver EXECUTE**, porque
`authenticated` alcança por PUBLIC, não por concessão própria. Logo a migration
dela tem de ser **posterior** a esta.

## Ordem recomendada

1. **Liberar o canal da Fase 2** para esta branch — único bloqueio para escrever
   o arquivo.
2. Escrever `20261027160000_…sql`. O rollback **já está em disco**.
3. Escrever o teste PGlite da seção 2.
4. Preencher os blocos A–F do checklist de deploy e o bloco da §13, item por
   item, no documento e no PR.
5. PR **separado** da correção de CPF ambíguo, submetido ao Guardião.
6. Mesclar. **Não aplicar em produção.**
7. Fazer os três registros acima.
8. Catraca de CI depois.

## O que esta estratégia não resolve

A linha de ledger continua não existindo, e a evidência oficial segue sendo o
relatório de segurança. A reconciliação das 410 versões só-arquivo e das 1.197
só-histórico não é desta frente.
