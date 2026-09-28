-- =============================================================================
-- PREVENTIVO — estrutura própria, isolada da cobrança
-- =============================================================================
--
-- O Preventivo é uma operação SEPARADA da cobrança: orienta o aluno a pagar a
-- mensalidade no WebAluno ANTES de o título virar dívida. Não cobra honorário,
-- não cria caso, não distribui operador, não entra em fidelização, acordo,
-- fila, meta ou resultado da cobrança.
--
-- POR QUE ESTRUTURA PRÓPRIA (prefixo `prev_`) E NÃO REUSO:
--   as tabelas da cobrança (`casos`, `acordos`, `acordos_titulos`, `alunos`)
--   têm GATILHO. Escrever nelas dispara reavaliação de caso, nivelamento,
--   reposição de carteira e recálculo de saldo. Qualquer reuso ali levaria o
--   Preventivo a mexer na cobrança por efeito colateral, que é exatamente o
--   que a gestão proibiu. Nenhuma tabela deste arquivo tem chave estrangeira
--   para tabela da cobrança, e nenhum gatilho aqui escreve fora do prefixo
--   `prev_`.
--
-- O ALUNO PODE EXISTIR NAS DUAS OPERAÇÕES. A separação é POR TÍTULO: a
-- identidade de um título preventivo é (carteira, matrícula Prime, documento).
-- Nada aqui atualiza "todas as pendências do aluno" — ver
-- `prev_titulo_snapshot`, que é por título, nunca por pessoa.
--
-- ACESSO: somente a Amanda da gestão (amanda.seibel@aelbra.com.br), conferido
-- no BANCO por `public.preventivo_e_gestao()`, em RLS e dentro de cada RPC.
-- Amanda ADM (cobranca07@aelbra.com.br) NÃO tem acesso — é outra conta, outro
-- perfil. A trava da interface é só conforto; a que vale é esta.
--
-- Nada aqui é aplicado automaticamente em produção. Reversão em
-- `supabase/rollbacks/20260928143743_preventivo_estrutura.sql`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PORTÃO DE ACESSO
-- -----------------------------------------------------------------------------
-- Mesma forma de `app_pode_borderos_importacoes()` (27/07): portão INTERNO por
-- e-mail do JWT, nunca `revoke` de `authenticated` — revogar derrubaria a
-- própria tela da gestão (erro já cometido em 12/09, ver
-- `restringir-a-gestao-e-portao-interno-nunca-revoke-de-authenticated`).
create or replace function public.preventivo_e_gestao()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    -- sem usuário final: só chamada interna de sistema (Edge Function com
    -- service_role, cron). Nunca `anon`.
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

comment on function public.preventivo_e_gestao() is
  'Preventivo: verdadeiro somente para a Amanda da gestão (amanda.seibel@aelbra.com.br, perfil gerencia, ativa) ou para chamada interna de sistema. Amanda ADM e demais perfis NÃO passam.';

revoke all on function public.preventivo_e_gestao() from public;
grant execute on function public.preventivo_e_gestao() to authenticated, service_role;

-- "Hoje" do Preventivo é sempre data de calendário em America/Sao_Paulo. Sem
-- isto, um título vencido ontem vira "vence hoje" entre 21h e 24h (UTC-3).
create or replace function public.preventivo_hoje()
returns date
language sql
stable
set search_path to 'public'
as $$ select ((now() at time zone 'America/Sao_Paulo')::date) $$;

comment on function public.preventivo_hoje() is
  'Data de calendário em America/Sao_Paulo. Toda regra de janela do Preventivo usa esta função, nunca current_date (que é UTC no servidor).';

grant execute on function public.preventivo_hoje() to authenticated, service_role;

-- Limite de permanência no Preventivo: 31 dias de atraso, em dias de
-- calendário São Paulo. No dia 31 ainda é preventivo; no 32 não é mais.
create or replace function public.preventivo_limite_dias()
returns integer language sql immutable as $$ select 31 $$;

create or replace function public.preventivo_dias_atraso(p_vencimento date)
returns integer
language sql
stable
set search_path to 'public'
as $$ select (public.preventivo_hoje() - p_vencimento) $$;

create or replace function public.preventivo_na_janela(p_vencimento date)
returns boolean
language sql
stable
set search_path to 'public'
as $$ select public.preventivo_dias_atraso(p_vencimento) <= public.preventivo_limite_dias() $$;

comment on function public.preventivo_na_janela(date) is
  'Título está na janela preventiva enquanto o atraso for <= 31 dias de calendário (America/Sao_Paulo). Título a vencer tem atraso negativo e também está na janela. Passou de 31, sai das ações novas e o histórico fica para consulta.';

grant execute on function public.preventivo_limite_dias() to authenticated, service_role;
grant execute on function public.preventivo_dias_atraso(date) to authenticated, service_role;
grant execute on function public.preventivo_na_janela(date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. CARTEIRA
-- -----------------------------------------------------------------------------
create table if not exists public.prev_carteira (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null,
  descricao      text,
  -- janela de vencimento ESCOLHIDA pela gestão no momento de criar a carteira.
  -- Não há antecedência padrão embutida: quem decide o recorte é quem opera.
  venc_de        date not null,
  venc_ate       date not null,
  criada_por     text not null,
  criada_em      timestamptz not null default now(),
  encerrada_em   timestamptz,
  constraint prev_carteira_nome_unico unique (nome),
  constraint prev_carteira_janela_coerente check (venc_ate >= venc_de)
);

comment on table public.prev_carteira is
  'Carteira preventiva: um recorte nomeado de títulos por janela de vencimento. O valor inicial em aberto é preservado título a título (prev_titulo.saldo_inicial), não recalculado.';

-- -----------------------------------------------------------------------------
-- 3. LOTE DE IMPORTAÇÃO
-- -----------------------------------------------------------------------------
create table if not exists public.prev_lote (
  id             uuid primary key default gen_random_uuid(),
  carteira_id    uuid not null references public.prev_carteira(id) on delete cascade,
  nome           text not null,
  arquivo_nome   text,
  mapeamento     jsonb not null default '{}'::jsonb,
  resumo         jsonb not null default '{}'::jsonb,
  conteudo_hash  text,
  status         text not null default 'CONFIRMADO'
                 check (status in ('CONFIRMADO', 'CANCELADO')),
  criado_por     text not null,
  criado_em      timestamptz not null default now(),
  constraint prev_lote_nome_unico unique (carteira_id, nome)
);

comment on column public.prev_lote.conteudo_hash is
  'md5 do conteúdo normalizado do arquivo. Reimportar o mesmo arquivo é permitido (atualiza), mas o hash igual é avisado na prévia para a gestão saber que não há novidade.';

-- Linhas que o arquivo trouxe e a importação RECUSOU, com o motivo. Ficam
-- gravadas: "linha recusada e seu motivo" é entregável, não log de tela.
create table if not exists public.prev_lote_recusa (
  id          bigserial primary key,
  lote_id     uuid not null references public.prev_lote(id) on delete cascade,
  linha       integer,
  motivo      text not null,
  dados       jsonb
);

-- -----------------------------------------------------------------------------
-- 4. TÍTULO PREVENTIVO
-- -----------------------------------------------------------------------------
-- CHAVE: (carteira, matrícula Prime, documento). Nome NUNCA entra na chave —
-- nome é do pagador/homônimo e já causou 10 baixas erradas na cobrança em
-- 08/09. `unidade` fica na tabela porque distingue título quando o relatório
-- de origem repete documento entre unidades; se isso acontecer, a importação
-- recusa a linha em vez de fundir dois títulos (ver RPC de importação).
create table if not exists public.prev_titulo (
  id                uuid primary key default gen_random_uuid(),
  carteira_id       uuid not null references public.prev_carteira(id) on delete cascade,
  matricula_prime   text not null,
  documento         text not null,
  unidade           text,
  contrato          text,
  aluno_nome        text not null,
  cpf               text,
  competencia       text,
  vencimento        date not null,
  valor_original    numeric(14,2) not null,
  saldo_inicial     numeric(14,2) not null,
  situacao_origem   text,
  celular           text,
  email             text,
  lote_origem_id    uuid references public.prev_lote(id) on delete set null,
  lote_ultimo_id    uuid references public.prev_lote(id) on delete set null,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),

  -- estado financeiro observado na última sincronização bem-sucedida
  saldo_atual       numeric(14,2),
  valor_bruto_prime numeric(14,2),
  valor_corrigido_prime numeric(14,2),
  portador_atual    integer,
  portador_nome     text,
  sinc_em           timestamptz,
  sinc_id           uuid,
  presente_no_extrato boolean,

  status            text not null default 'ATIVO'
                    check (status in ('ATIVO', 'FORA_DA_JANELA')),
  saiu_em           date,
  saida_motivo      text,

  constraint prev_titulo_chave unique (carteira_id, matricula_prime, documento)
);

comment on table public.prev_titulo is
  'Um título de mensalidade dentro de uma carteira preventiva. saldo_inicial é o valor em aberto na ENTRADA e nunca é reescrito por sincronização — é o denominador do painel.';
comment on column public.prev_titulo.saldo_atual is
  'Último saldo observado no Prime. NULL = nunca sincronizado com sucesso. Falha de consulta NÃO zera nem apaga este valor: preserva o anterior e a tela mostra que está desatualizado (prev_titulo.sinc_em).';
comment on column public.prev_titulo.status is
  'ATIVO enquanto na janela (atraso <= 31 dias corridos, America/Sao_Paulo). FORA_DA_JANELA sai das ações NOVAS e mantém todo o histórico para consulta. O título NÃO é transferido para a cobrança por esta rotina.';

create index if not exists prev_titulo_carteira_status_idx on public.prev_titulo (carteira_id, status);
create index if not exists prev_titulo_vencimento_idx      on public.prev_titulo (carteira_id, vencimento);
create index if not exists prev_titulo_matricula_idx       on public.prev_titulo (matricula_prime);
create index if not exists prev_titulo_documento_idx       on public.prev_titulo (documento);

-- Qual lote trouxe qual título. O mesmo título pode aparecer em vários lotes;
-- o consolidado conta pelo TÍTULO, nunca pela linha de lote — é o que impede
-- dobra de valor no painel.
create table if not exists public.prev_titulo_lote (
  titulo_id    uuid not null references public.prev_titulo(id) on delete cascade,
  lote_id      uuid not null references public.prev_lote(id) on delete cascade,
  primeira_vez boolean not null default false,
  visto_em     timestamptz not null default now(),
  primary key (titulo_id, lote_id)
);

-- -----------------------------------------------------------------------------
-- 5. SINCRONIZAÇÃO COM O PRIME
-- -----------------------------------------------------------------------------
create table if not exists public.prev_sinc (
  id             uuid primary key default gen_random_uuid(),
  carteira_id    uuid references public.prev_carteira(id) on delete cascade,
  origem         text not null check (origem in ('cron', 'manual')),
  solicitado_por text,
  iniciado_em    timestamptz not null default now(),
  concluido_em   timestamptz,
  status         text not null default 'EM_ANDAMENTO'
                 check (status in ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU')),
  alvos          integer not null default 0,
  consultados    integer not null default 0,
  erros          integer not null default 0,
  mensagem       text
);

comment on table public.prev_sinc is
  'Um ciclo de consulta ao Prime. A tela mostra a ÚLTIMA CONCLUÍDA com sucesso — ciclo que falhou não vira "atualizado".';

create index if not exists prev_sinc_carteira_idx on public.prev_sinc (carteira_id, iniciado_em desc);

-- Fila própria, restrita às matrículas da carteira preventiva. NÃO reusa
-- `prime_extrato_fila`: aquela fila varre os 17.7 mil alunos da base e roda no
-- mutirão de sábado (cron `prime_extrato_mutirao`, `*/2 2-23 * * 6`). Enfileirar
-- o Preventivo lá significaria (a) esperar até sábado, (b) empurrar a operação
-- da cobrança para dentro de uma varredura diária que ela não pede.
create table if not exists public.prev_sinc_fila (
  sinc_id     uuid not null references public.prev_sinc(id) on delete cascade,
  matricula   text not null,
  coletado_em timestamptz,
  tentativas  integer not null default 0,
  ultimo_erro text,
  primary key (sinc_id, matricula)
);

create index if not exists prev_sinc_fila_pendente_idx
  on public.prev_sinc_fila (sinc_id) where coletado_em is null;

-- Foto do título a cada ciclo. É append-only e é daqui que sai TODO evento
-- financeiro — nunca de uma comparação com "o que eu lembrava".
create table if not exists public.prev_titulo_snapshot (
  id                  bigserial primary key,
  sinc_id             uuid not null references public.prev_sinc(id) on delete cascade,
  titulo_id           uuid not null references public.prev_titulo(id) on delete cascade,
  observado_em        timestamptz not null default now(),
  presente_no_extrato boolean not null,
  saldo               numeric(14,2),
  valor_bruto         numeric(14,2),
  valor_corrigido     numeric(14,2),
  vencimento          date,
  portador            integer,
  liquidado_em_prime  date,
  constraint prev_snapshot_unico unique (sinc_id, titulo_id)
);

comment on column public.prev_titulo_snapshot.valor_corrigido is
  'paidAmount cru do Prime. GUARDADO PARA ESTUDO, NUNCA SOMADO COMO CAIXA: medido em 28/09/2026 que paidAmount é valor de tabela/dívida corrigida — aparece como o DOBRO exato do principal em títulos vencidos e MAIOR que o principal em títulos ainda a vencer. Ver docs/integracoes/prime-api.md.';
comment on column public.prev_titulo_snapshot.liquidado_em_prime is
  'paymentDate cru do Prime. GUARDADO, NUNCA INTERPRETADO COMO PAGAMENTO: medido em 28/09/2026 que 100% das linhas do extrato têm paymentDate preenchido, inclusive títulos a vencer (0 de 302.477 linhas do portador 95 com paymentDate nulo). Ver docs/integracoes/prime-api.md.';

-- -----------------------------------------------------------------------------
-- 6. EVENTO FINANCEIRO OBSERVADO
-- -----------------------------------------------------------------------------
-- NENHUM destes tipos é "pagamento" por si. A API do Prime não expõe evento de
-- pagamento, situação do título nem saldo em aberto (conferido ao vivo em
-- 28/09/2026: `financialStatement` tem 13 campos, nenhum de situação). O que
-- observamos é MOVIMENTO DE SALDO. Redução de saldo NÃO é dinheiro recebido:
-- pode ser cancelamento, bolsa, renegociação ou ajuste. Por isso o tipo vem
-- separado e `e_pagamento_comprovado` existe, começa sempre falso, e só muda
-- quando houver fonte que prove data e valor do pagamento.
create table if not exists public.prev_evento (
  id                     bigserial primary key,
  titulo_id              uuid not null references public.prev_titulo(id) on delete cascade,
  sinc_id                uuid not null references public.prev_sinc(id) on delete cascade,
  tipo                   text not null check (tipo in (
                           'QUITACAO_OBSERVADA',
                           'REDUCAO_SALDO_OBSERVADA',
                           'AUMENTO_SALDO_OBSERVADO',
                           'MUDANCA_DE_PORTADOR',
                           'AUSENTE_NO_EXTRATO',
                           'RETORNO_AO_EXTRATO')),
  saldo_antes            numeric(14,2),
  saldo_depois           numeric(14,2),
  valor_delta            numeric(14,2),
  observado_em           timestamptz not null default now(),
  e_pagamento_comprovado boolean not null default false,
  detalhe                jsonb not null default '{}'::jsonb,
  -- idempotência: o mesmo movimento observado de novo não vira segundo evento
  chave                  text not null,
  constraint prev_evento_chave_unica unique (chave)
);

comment on table public.prev_evento is
  'Movimento de saldo observado título a título entre duas sincronizações. NÃO é registro de pagamento. Reconsultar o Prime não duplica evento: a coluna `chave` é única e carrega titulo + tipo + saldos + dia.';
comment on column public.prev_evento.e_pagamento_comprovado is
  'Sempre falso hoje. Só pode virar verdadeiro com fonte que traga DATA e VALOR do pagamento — a API do Prime não traz nenhuma das duas (paidAmount é dívida corrigida/valor de tabela, não caixa). Ver docs/integracoes/prime-gaps.md.';

create index if not exists prev_evento_titulo_idx on public.prev_evento (titulo_id, observado_em desc);
create index if not exists prev_evento_tipo_idx   on public.prev_evento (tipo, observado_em desc);

-- -----------------------------------------------------------------------------
-- 7. AÇÕES E EXPORTAÇÃO PARA A MENSAGERIA
-- -----------------------------------------------------------------------------
-- EXPORTAR NÃO É ENVIAR. Os quatro estados existem para que "exportei a lista"
-- nunca seja lido como "a pessoa recebeu". Nada neste módulo dispara mensagem:
-- o envio é feito pelo CRM de mensageria, fora daqui.
create table if not exists public.prev_acao (
  id                   uuid primary key default gen_random_uuid(),
  carteira_id          uuid not null references public.prev_carteira(id) on delete cascade,
  nome                 text not null,
  canal                text not null check (canal in ('WHATSAPP', 'EMAIL')),
  filtros              jsonb not null default '{}'::jsonb,
  estado               text not null default 'PREPARADA'
                       check (estado in ('PREPARADA', 'EXPORTADA', 'ENVIO_CONFIRMADO', 'CANCELADA')),
  -- qual foto financeira a gestão tinha na tela quando montou o público
  sinc_referencia_id   uuid references public.prev_sinc(id) on delete set null,
  sinc_referencia_em   timestamptz,
  criada_por           text not null,
  criada_em            timestamptz not null default now(),
  exportada_em         timestamptz,
  envio_confirmado_em  timestamptz,
  cancelada_em         timestamptz,
  observacao           text,
  constraint prev_acao_nome_unico unique (carteira_id, nome)
);

comment on column public.prev_acao.envio_confirmado_em is
  'Marcado à mão pela gestão DEPOIS que a mensageria enviou. Entrega e leitura só entram se a mensageria devolver retorno real — não existe estimativa aqui.';

create table if not exists public.prev_acao_destinatario (
  id            bigserial primary key,
  acao_id       uuid not null references public.prev_acao(id) on delete cascade,
  titulo_id     uuid not null references public.prev_titulo(id) on delete cascade,
  matricula     text not null,
  aluno_nome    text not null,
  contato       text,
  incluido      boolean not null default true,
  motivo        text,
  constraint prev_acao_destinatario_unico unique (acao_id, titulo_id)
);

comment on column public.prev_acao_destinatario.incluido is
  'Falso = separado do público, com o motivo ao lado (sem celular válido, telefone fixo, e-mail inválido, número compartilhado com outro aluno, fora da janela, saldo zerado). Nada é corrigido em silêncio.';

create index if not exists prev_acao_dest_acao_idx on public.prev_acao_destinatario (acao_id, incluido);

-- -----------------------------------------------------------------------------
-- 8. RLS — a trava que vale
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'prev_carteira', 'prev_lote', 'prev_lote_recusa', 'prev_titulo',
    'prev_titulo_lote', 'prev_sinc', 'prev_sinc_fila', 'prev_titulo_snapshot',
    'prev_evento', 'prev_acao', 'prev_acao_destinatario'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_somente_gestao', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.preventivo_e_gestao()) with check (public.preventivo_e_gestao())',
      t || '_somente_gestao', t);
    -- `anon` nunca chega nestas tabelas, nem para contar linha
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Sequências das tabelas com bigserial: só as do Preventivo. Um
-- `revoke ... on all sequences in schema public` aqui atingiria tabela de
-- outra frente e derrubaria escrita que nada tem a ver com isto.
do $$
declare s text;
begin
  foreach s in array array[
    'prev_lote_recusa_id_seq', 'prev_titulo_snapshot_id_seq',
    'prev_evento_id_seq', 'prev_acao_destinatario_id_seq'
  ] loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.relkind = 'S' and n.nspname = 'public' and c.relname = s) then
      execute format('revoke all on sequence public.%I from anon', s);
      execute format('grant usage, select on sequence public.%I to authenticated', s);
    end if;
  end loop;
end
$$;
