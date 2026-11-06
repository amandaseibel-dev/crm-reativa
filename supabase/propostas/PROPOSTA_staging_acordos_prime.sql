-- PROPOSTA (não aplicada) — Staging isolado para a integração de ACORDOS
-- Mannesoft Prime → ReATIVA One.
--
-- Esta proposta NÃO toca `acordos`, `acordos_titulos`, `parcelas` nem
-- `baixas_pagamento`. Não cria mecanismo de baixa ou cancelamento paralelo.
-- Não reusa `duplicado_de`/`duplicado_marcado_em` nem presume `numero_ulbra`
-- único — decisões já fechadas nas rodadas de diagnóstico anteriores
-- (ver docs/integracoes/prime-acordos-staging.md).
--
-- Vive em supabase/propostas/ (não em supabase/migrations/) porque o
-- Guardião só libera escrita em migrations com autorização de Fase 2 banco
-- (REATIVA_FASE2_BANCO ou TSV aprovado em origin/main) — autorização que
-- esta tarefa explicitamente NÃO tem e não solicita agora. Isto é código
-- pronto para revisão, não uma migration a aplicar.
--
-- Decisão de identidade (fechada na rodada anterior): a chave do acordo é
-- (número do acordo no Mannesoft + identificador estável do aluno).
-- Carteira/portador NUNCA faz parte da chave — é atributo versionado,
-- porque não foi comprovado que permanece fixo durante o ciclo de vida do
-- acordo, e tratá-la como identidade arriscaria duplicar o mesmo acordo se
-- ela mudar entre duas capturas.

-- ============================================================================
-- 1. HISTÓRICO DE CAPTURAS (append-only — nunca UPDATE de linha existente,
--    só INSERT de uma nova versão para a mesma chave_acordo)
-- ============================================================================
create table if not exists public.acordos_prime_staging (
  id                      uuid primary key default gen_random_uuid(),

  -- Identidade do ACORDO (permanente, nunca muda entre versões da mesma chave)
  chave_acordo            text not null,
  numero_acordo_mannesoft text not null,
  identificador_aluno     text not null, -- CPF formatado (hierarquia já documentada em prime-mapa-identificadores.md)
  aluno_id                uuid null,      -- preenchido só depois de resolvido contra `alunos`; pode ficar null

  -- Atributos VERSIONADOS (podem variar de captura para captura; nunca compõem a chave)
  carteira_portador       text null,
  situacao_mannesoft      text not null,
  tipo_mannesoft          text null,      -- texto cru do Mannesoft (ex.: "Acordo", "Reacordo"); nunca inferido

  -- Renegociação encadeada: só preenchido quando o PRÓPRIO Mannesoft
  -- referencia explicitamente o acordo anterior na tela do Acordo-Detalhe.
  -- Nunca inferido por proximidade de data, valor ou CPF repetido. A cadeia
  -- de renegociações sucessivas é a sequência dessas referências, resolvida
  -- elo a elo (ver montarCadeiaReacordo em prime-acordos-staging.ts) — nunca
  -- reconstruída por heurística.
  acordo_anterior_mannesoft text null,

  -- Composição completa, como a tela do Acordo-Detalhe mostra: GRUPO de
  -- títulos negociados + GRUPO de títulos gerados. Nunca um emparelhamento
  -- individual que o Mannesoft não ofereça explicitamente. Cada título
  -- (negociado ou gerado) preserva, quando informado, portador/convênio
  -- brutos (ver IdentificacaoPortador em prime-acordos-staging.ts) — é
  -- contra os títulos GERADOS que se comprova o vínculo com o convênio
  -- Santander ReATIVA (272047/portador 166); os títulos negociados nunca são
  -- filtrados por portador de origem.
  composicao              jsonb not null,
  composicao_hash         text not null,

  -- Identidade da CAPTURA (varia a cada execução — nunca confundir com a identidade do acordo)
  lote_captura_id         uuid not null,
  captura_em              timestamptz not null default now(),
  origem                  text not null default 'MANNESOFT_ACORDO_DETALHE',

  -- Detecção de conflito DENTRO do próprio lote (duas linhas do mesmo lote com a mesma chave)
  conflito_na_captura     boolean not null default false,
  conflito_motivo         text null,

  criado_em               timestamptz not null default now()
);

comment on table public.acordos_prime_staging is
  'Staging isolado da integração ACORDOS Prime/ULBRA. Append-only: histórico de capturas por chave_acordo. Não é lido por nenhuma rotina financeira existente. Promoção para acordos/acordos_titulos só ocorre via rotina oficial, nunca por escrita direta a partir desta tabela.';

create index if not exists idx_acordos_prime_staging_chave
  on public.acordos_prime_staging (chave_acordo, captura_em desc);

create index if not exists idx_acordos_prime_staging_lote
  on public.acordos_prime_staging (lote_captura_id);

create index if not exists idx_acordos_prime_staging_aluno
  on public.acordos_prime_staging (aluno_id) where aluno_id is not null;

-- Colisão de chave DENTRO DO MESMO LOTE: duas linhas do mesmo lote_captura_id
-- com a mesma chave_acordo é o cenário que a Etapa 1 precisa autodetectar.
-- Fica como índice parcial de apoio à consulta de verificação (não é UNIQUE
-- — o objetivo é A CAPTURA ENCONTRAR o conflito e marcar conflito_na_captura,
-- não o banco rejeitar a escrita, porque rejeitar perderia a evidência do
-- próprio conflito).
create index if not exists idx_acordos_prime_staging_colisao_lote
  on public.acordos_prime_staging (lote_captura_id, chave_acordo);

-- Última versão conhecida de cada acordo — leitura de apoio para a camada de
-- comparação (nunca para decidir escrita financeira).
create or replace view public.acordos_prime_staging_atual as
select distinct on (chave_acordo) *
from public.acordos_prime_staging
order by chave_acordo, captura_em desc, criado_em desc;

comment on view public.acordos_prime_staging_atual is
  'Última versão capturada de cada chave_acordo. Leitura de apoio, nunca fonte de escrita financeira.';

-- ============================================================================
-- 2. CRÍTICAS/EXCEÇÕES — molde de `importacao_acordo_critica`, mas com
--    identidade e significado PRÓPRIOS desta integração. Nunca grava na
--    tabela de crítica da importação de boletos existente.
-- ============================================================================
create table if not exists public.acordos_prime_staging_criticas (
  id                uuid primary key default gen_random_uuid(),
  staging_id        uuid null references public.acordos_prime_staging(id),
  chave_acordo      text not null,
  codigo            text not null,
    -- valores esperados (lista fechada, ver prime-acordos-staging.ts):
    --   COLISAO_CHAVE_NO_LOTE
    --   IDENTIDADE_ALUNO_DIVERGENTE
    --   VINCULO_NAO_FORTE
    --   QUITACAO_OBSERVADA_EXTERNA
    --   CANCELAMENTO_SEM_PRE_CHECAGEM
    --   CARTEIRA_MUDOU_ENTRE_CAPTURAS
    --   FORMATO_NAO_VALIDADO_PARA_IMPORTADOR
    --   IDENTIDADE_AMBIGUA_REFERENCIA_NAO_RESOLVIDA  -- referência a acordo anterior que o staging não encontra
    --   COMPOSICAO_DIVERGENTE_MULTIPLOS_ACORDOS_DE_ORIGEM  -- parcelas herdadas referenciando mais de um acordo de origem
    --   INFORMACAO_INSUFICIENTE_ORIGEM_DO_TITULO_SEM_REFERENCIA  -- parcela herdada sem dizer de qual acordo vem
    --   VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO  -- títulos gerados sem portador/convênio informado (nenhum, ou algum)
    --   VINCULO_CONVENIO_REATIVA_DIVERGENTE  -- título gerado aponta portador/convênio diferente de 166/272047
    --
    -- NOTA (rodada 3): REACORDO_APOS_CANCELAMENTO e COMPOSICAO_MISTA_EXIGE_CONFERENCIA
    -- deixaram de ser códigos de EXCEÇÃO automática — esses cenários (e os demais
    -- de renegociação) agora são reconhecidos automaticamente no staging quando a
    -- captura é inequívoca (ver avaliarReconhecimento() em prime-acordos-staging.ts).
    -- Os dois códigos ficam aqui apenas como histórico de nomenclatura; uma captura
    -- rotulada como reacordo-após-cancelamento ou composição mista só gera linha
    -- nesta tabela quando também cair em um dos três motivos acima.
  detalhes          jsonb null,
  status            text not null default 'ABERTA', -- ABERTA | REVISADA | RESOLVIDA
  revisado_por_email text null,
  revisado_em       timestamptz null,
  criado_em         timestamptz not null default now()
);

comment on table public.acordos_prime_staging_criticas is
  'Exceções da integração ACORDOS Prime/ULBRA que exigem conferência humana antes de qualquer promoção. Tabela própria — nunca reaproveita importacao_acordo_critica. Só recebe linha quando avaliarReconhecimento() devolve classe EXCECAO — uma captura PARCIAL (identidade e vínculo com o convênio ReATIVA comprovados, composição completa ainda desconhecida, típico de pagamento observado) nunca entra aqui: fica só em acordos_prime_staging, pendente de complementação, sem conferência forçada.';

create index if not exists idx_acordos_prime_staging_criticas_abertas
  on public.acordos_prime_staging_criticas (chave_acordo)
  where status = 'ABERTA';

-- ============================================================================
-- 3. ACESSO, RLS E ISOLAMENTO
--
-- Revisado pela skill `seguranca-rls` em 05/11/2026, contra
-- docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md §2 a §7.
--
-- DECISÃO DE PERFIL, e o porquê: estas tabelas são **gestão-only**. Não há
-- policy de leitura para operador, e isso não é excesso de zelo — o staging
-- guarda CPF (`identificador_aluno`) e composição de dívida de acordos de TODA
-- a base, não da carteira de quem consulta. Premissa §2: operador vê apenas a
-- própria carteira. Uma policy por carteira aqui seria inventar um recorte que
-- a tabela não tem (um acordo capturado pode nem ter `aluno_id` resolvido
-- ainda), então o recorte correto é nenhum: operador não lê.
--
-- Premissa §3.5: leitura que não é do operador vai por deny-all + gestão, e
-- qualquer consumo futuro por operador terá de ser RPC `SECURITY DEFINER` com
-- recorte explícito — não ampliação destas policies.
-- ============================================================================

alter table public.acordos_prime_staging          enable row level security;
alter table public.acordos_prime_staging_criticas enable row level security;

-- ----------------------------------------------------------------------------
-- 3.1 GRANTS — fechar antes de abrir.
--
-- A ARMADILHA, que já custou caro aqui (premissa §10 e o alerta da skill):
-- tabela nova em `public` NASCE com privilégio para `authenticated` por
-- ALTER DEFAULT PRIVILEGES, **inclusive TRUNCATE** — e RLS **não cobre
-- TRUNCATE**. Sem o revoke abaixo, qualquer usuário logado apaga o staging
-- inteiro sem violar policy nenhuma.
-- ----------------------------------------------------------------------------
revoke all on public.acordos_prime_staging          from public, anon, authenticated;
revoke all on public.acordos_prime_staging_criticas from public, anon, authenticated;
revoke all on public.acordos_prime_staging_atual    from public, anon, authenticated;

-- `authenticated` recebe SELECT, e só; a RLS abaixo restringe a gestão.
-- Nenhum INSERT/UPDATE/DELETE/TRUNCATE para o navegador: a escrita do staging
-- é da rotina de captura, que fala como `service_role` pela Edge Function.
grant select on public.acordos_prime_staging       to authenticated;
grant select on public.acordos_prime_staging_atual to authenticated;

-- Críticas: gestão lê e revisa (muda `status`/`revisado_*`). O UPDATE é
-- restringido por policy E por grant de coluna — sem o grant de coluna, uma
-- policy permissiva deixaria a gestão reescrever `codigo` e `detalhes`, que são
-- a evidência do que foi detectado.
grant select on public.acordos_prime_staging_criticas to authenticated;
grant update (status, revisado_por_email, revisado_em)
  on public.acordos_prime_staging_criticas to authenticated;

-- `service_role` escreve. Nunca no navegador (premissa §5).
grant select, insert on public.acordos_prime_staging          to service_role;
grant select, insert on public.acordos_prime_staging_criticas to service_role;
grant select            on public.acordos_prime_staging_atual to service_role;

-- Append-only de verdade: nem a gestão nem o serviço fazem UPDATE ou DELETE em
-- `acordos_prime_staging`. Corrigir captura errada é capturar de novo — a
-- versão nova vence pela view `_atual`, e a errada permanece como evidência.
-- (Por isso o grant acima concede apenas SELECT e INSERT, sem UPDATE/DELETE.)

-- ----------------------------------------------------------------------------
-- 3.2 POLICIES — mínimas e explícitas por comando (premissa §3.3).
-- Nenhum `USING (true)`: toda policy passa por `usuario_e_gestao()`, que é
-- SECURITY DEFINER com search_path fixo e decide pelo JWT, no banco.
-- ----------------------------------------------------------------------------
drop policy if exists acordos_prime_staging_select_gestao on public.acordos_prime_staging;
create policy acordos_prime_staging_select_gestao
  on public.acordos_prime_staging
  for select
  to authenticated
  using (public.usuario_e_gestao());

drop policy if exists acordos_prime_staging_criticas_select_gestao on public.acordos_prime_staging_criticas;
create policy acordos_prime_staging_criticas_select_gestao
  on public.acordos_prime_staging_criticas
  for select
  to authenticated
  using (public.usuario_e_gestao());

-- Revisão de crítica: gestão muda o status, e o `WITH CHECK` impede que a
-- linha saia do conjunto que ela podia ver (premissa §3.3 — policy por
-- comando, com USING e WITH CHECK explícitos).
drop policy if exists acordos_prime_staging_criticas_update_gestao on public.acordos_prime_staging_criticas;
create policy acordos_prime_staging_criticas_update_gestao
  on public.acordos_prime_staging_criticas
  for update
  to authenticated
  using (public.usuario_e_gestao())
  with check (public.usuario_e_gestao());

-- NÃO existe policy de INSERT/DELETE para `authenticated` em nenhuma das duas,
-- e isso é deliberado: sem policy, o comando é negado. `service_role` escreve
-- porque contorna RLS por desenho do Postgres (BYPASSRLS), não porque alguém
-- lhe deu policy.

-- ----------------------------------------------------------------------------
-- 3.3 VIEW — `security_invoker` ligado (premissa §6).
-- Sem isto a view rodaria com os direitos do dono e viraria uma porta lateral
-- para ler o staging inteiro sem passar pela RLS da tabela.
-- ----------------------------------------------------------------------------
alter view public.acordos_prime_staging_atual set (security_invoker = true);

-- ----------------------------------------------------------------------------
-- 3.4 DADO PESSOAL (premissa §7)
--
-- `identificador_aluno` é CPF formatado, e `composicao` traz valores de dívida.
-- O acesso é gestão-only, que é o perfil que já vê CPF sem máscara nas telas
-- financeiras — não há ampliação de exposição em relação ao que a gestão já
-- alcança. Nenhuma view de leitura geral nova é criada para operador, e a
-- `_atual` herda a mesma RLS por `security_invoker`.
--
-- O que NÃO foi feito, e fica declarado: não há mascaramento de CPF nesta
-- camada, porque mascarar o identificador quebraria a própria função do
-- staging (resolver identidade contra `alunos`). Se um dia houver leitura por
-- operador, ela nasce como RPC que devolve CPF mascarado, nunca como grant.
-- ============================================================================
