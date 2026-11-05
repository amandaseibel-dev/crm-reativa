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

  -- Composição completa, como a tela do Acordo-Detalhe mostra: GRUPO de
  -- títulos negociados + GRUPO de títulos gerados. Nunca um emparelhamento
  -- individual que o Mannesoft não ofereça explicitamente.
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
  detalhes          jsonb null,
  status            text not null default 'ABERTA', -- ABERTA | REVISADA | RESOLVIDA
  revisado_por_email text null,
  revisado_em       timestamptz null,
  criado_em         timestamptz not null default now()
);

comment on table public.acordos_prime_staging_criticas is
  'Exceções da integração ACORDOS Prime/ULBRA que exigem conferência humana antes de qualquer promoção. Tabela própria — nunca reaproveita importacao_acordo_critica.';

create index if not exists idx_acordos_prime_staging_criticas_abertas
  on public.acordos_prime_staging_criticas (chave_acordo)
  where status = 'ABERTA';

-- ============================================================================
-- Acesso e RLS: DELIBERADAMENTE NÃO incluídos nesta proposta.
-- Antes de qualquer aplicação real, passar pela skill `seguranca-rls`
-- (CLAUDE.md item 7) — grants padrão de `CREATE TABLE` não são suficientes
-- para tabela que vai receber escrita de serviço e leitura de gestão.
-- ============================================================================
