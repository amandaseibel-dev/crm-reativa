-- Catálogo editável de tabulações.
--
-- PROBLEMA: a lista de tabulações estava hardcoded e DUPLICADA em 5 arquivos
-- do frontend (Aluno.jsx, PainelCarteira.jsx, FilaOperacional.jsx,
-- AgendaOperacional.jsx, InfoRegistroAluno.jsx), junto com as regras que o
-- sistema deriva delas (rótulo visível, próxima ação, prazo de retorno
-- automático em dias úteis, bloco da ficha que abre). Incluir ou tirar uma
-- tabulação exigia mexer em código e publicar. As listas já estavam
-- divergentes entre si (ELOGIO_ATENDIMENTO só existia no Aluno.jsx).
--
-- SOLUÇÃO: uma tabela `tabulacoes` como fonte única de verdade. O frontend lê
-- daqui; a gestão inclui/edita/desativa pela tela, sem deploy.
--
-- REGRA CENTRAL -- "respeitar o que já está agendado até o novo agendamento":
-- mexer no catálogo NUNCA reescreve agendamento existente. Não há backfill,
-- trigger ou cron que releia o catálogo e recalcule `data_retorno`. Uma
-- tabulação nova, um prazo alterado ou uma tabulação desativada só produzem
-- efeito na PRÓXIMA vez que aquele aluno for tabulado. Quem está hoje com
-- retorno marcado pro dia 25 continua no dia 25.
--
-- EXCLUIR = DESATIVAR (ativa=false), nunca DELETE. Motivos:
--   1) 4.833 alunos estão em AGUARDANDO_BAIXA e 2.314 em MENSAGEM_ENVIADA
--      (contagem em 2026-08-17); um DELETE deixaria esses casos com um código
--      órfão e sem rótulo legível.
--   2) `aluno_movimentacoes.status_anterior/status_novo` guarda o histórico
--      por código -- o histórico precisa continuar legível pra sempre.
--   3) É reversível: reativar devolve a opção à lista.
-- A linha desativada some da lista de tabular, mas continua resolvendo rótulo
-- no histórico e nas fichas de quem ficou nela.
--
-- SEGURANÇA: leitura liberada a qualquer usuário autenticado (é catálogo, não
-- tem PII); escrita SÓ por public.usuario_e_gestao() (Amanda, Fernanda,
-- Amanda ADM), via RPC SECURITY DEFINER. A tabela não tem policy de
-- INSERT/UPDATE/DELETE -- nem gestão escreve direto nela.

-- ---------------------------------------------------------------------------
-- 1) Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.tabulacoes (
  codigo               text primary key,
  rotulo               text not null,
  ativa                boolean not null default true,
  ordem                integer not null default 500,
  grupo                text not null default 'CONTATO',
  -- Como o retorno é agendado quando o operador tabula sem digitar data:
  --   NENHUM     -> não agenda nada
  --   MANUAL     -> o operador precisa escolher a data (nada é sugerido)
  --   DIAS_UTEIS -> hoje + retorno_dias_uteis dias úteis
  retorno_modo         text not null default 'NENHUM',
  retorno_dias_uteis   integer,
  proxima_acao         text not null default 'CONTATAR',
  -- Bloco expansível da ficha que abre sozinho ao escolher a tabulação.
  -- Valores usados hoje: link | termo | financeiro | confirmar.
  bloco_ficha          text,
  exige_processo       boolean not null default false,
  bloqueia_acionamento boolean not null default false,
  -- sistema=true: alguma fila/trigger do backend casa por este código
  -- (confirmação de pagamento, termos, financeiro, links). Desativar é
  -- PERMITIDO, mas a tela avisa o impacto antes de confirmar.
  sistema              boolean not null default false,
  criado_em            timestamptz not null default now(),
  criado_por           text,
  atualizado_em        timestamptz,
  atualizado_por       text,
  desativada_em        timestamptz,
  desativada_por       text,
  constraint tabulacoes_codigo_formato
    check (codigo ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  constraint tabulacoes_rotulo_nao_vazio
    check (length(btrim(rotulo)) between 1 and 80),
  constraint tabulacoes_grupo_valido
    check (grupo in ('CONTATO','LINK','TERMO','FINANCEIRO','ENCERRAMENTO')),
  constraint tabulacoes_retorno_modo_valido
    check (retorno_modo in ('NENHUM','MANUAL','DIAS_UTEIS')),
  -- DIAS_UTEIS exige o prazo; os outros modos não podem ter prazo pendurado.
  constraint tabulacoes_retorno_coerente
    check (
      (retorno_modo = 'DIAS_UTEIS' and retorno_dias_uteis between 0 and 365)
      or (retorno_modo <> 'DIAS_UTEIS' and retorno_dias_uteis is null)
    ),
  constraint tabulacoes_bloco_valido
    check (bloco_ficha is null or bloco_ficha in ('link','termo','financeiro','confirmar'))
);

-- Rótulo único entre as ATIVAS, pra não existirem duas opções idênticas na
-- lista do operador. Inativas ficam de fora do índice (podem repetir rótulo de
-- uma substituta).
create unique index if not exists ux_tabulacoes_rotulo_ativa
  on public.tabulacoes (lower(btrim(rotulo))) where ativa;

create index if not exists ix_tabulacoes_ativa_ordem
  on public.tabulacoes (ativa, ordem, rotulo);

comment on table public.tabulacoes is
  'Catálogo de tabulações do CRM. Fonte única de verdade pro frontend. Editar aqui NÃO altera agendamento já existente -- a regra nova só vale a partir da próxima tabulação do aluno.';

-- ---------------------------------------------------------------------------
-- 2) Seed -- exatamente as tabulações que já existiam no código
-- ---------------------------------------------------------------------------
-- ativa=false nas que hoje NÃO aparecem no seletor mas existem na base
-- (LINK_ENVIADO_AO_ALUNO é gravada por RPC; QUITADO_MANUAL vem do "Quitar
-- tudo"). Ficam catalogadas só pra resolver o rótulo no histórico.
insert into public.tabulacoes
  (codigo, rotulo, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloco_ficha, exige_processo, bloqueia_acionamento, sistema, ativa, criado_por)
values
  ('CONTATAR',                'A contatar',            10, 'CONTATO',      'NENHUM',     null, 'CONTATAR',            null,        false, false, false, true,  'seed'),
  ('MENSAGEM_ENVIADA',        'Mensagem enviada',      20, 'CONTATO',      'DIAS_UTEIS',    2, 'CONTATAR',            null,        false, false, false, true,  'seed'),
  ('EM_ATENDIMENTO',          'Em atendimento',        30, 'CONTATO',      'NENHUM',     null, 'CONTATAR',            null,        false, false, false, true,  'seed'),
  ('ALUNO_EM_NEGOCIACAO_24H', 'Em negociação',         40, 'CONTATO',      'MANUAL',     null, 'RETORNAR',            null,        false, false, false, true,  'seed'),
  ('RETORNAR_DEPOIS',         'Retornar depois',       50, 'CONTATO',      'MANUAL',     null, 'RETORNAR',            null,        false, false, false, true,  'seed'),
  ('SEM_RETORNO',             'Sem retorno',           60, 'CONTATO',      'NENHUM',     null, 'CONTATAR',            null,        false, false, false, true,  'seed'),
  ('NAO_LOCALIZADO',          'Não localizado',        70, 'CONTATO',      'DIAS_UTEIS',    1, 'TENTAR_NOVO_CONTATO', null,        false, false, false, true,  'seed'),
  ('AGUARDANDO_LINK',         'Aguardando link',      110, 'LINK',         'DIAS_UTEIS',    1, 'CONTATAR',            'link',      false, false, true,  true,  'seed'),
  ('SOLICITADO_LINK',         'Link solicitado',      120, 'LINK',         'DIAS_UTEIS',    1, 'CONTATAR',            'link',      false, false, true,  true,  'seed'),
  ('LINK_PRONTO_PARA_ENVIO',  'Link pronto p/ envio', 130, 'LINK',         'DIAS_UTEIS',    1, 'ENVIAR_LINK_AO_ALUNO','link',      false, false, true,  true,  'seed'),
  ('LINK_ENVIADO_AO_ALUNO',   'Link enviado ao aluno',140, 'LINK',         'NENHUM',     null, 'CONTATAR',            'link',      false, false, true,  false, 'seed'),
  ('AGUARDANDO_COMPROVANTE',  'Aguardando comprovante',150,'LINK',         'DIAS_UTEIS',    3, 'CONTATAR',            'link',      false, false, true,  true,  'seed'),
  ('TERMO_ENVIADO_ALUNO',     'Termo enviado ao aluno',210,'TERMO',        'DIAS_UTEIS',    2, 'CONTATAR',            'termo',     false, false, true,  true,  'seed'),
  ('TERMO_ENVIADO_ADM',       'Enviado ao ADM',       220, 'TERMO',        'NENHUM',     null, 'CONTATAR',            'termo',     false, false, true,  true,  'seed'),
  ('TERMO_RECEBIDO_LIBERADO', 'Termo liberado',       230, 'TERMO',        'NENHUM',     null, 'CONTATAR',            'termo',     false, false, true,  true,  'seed'),
  ('TERMO_REJEITADO',         'Termo rejeitado',      240, 'TERMO',        'NENHUM',     null, 'CONTATAR',            'termo',     false, false, true,  true,  'seed'),
  ('ACORDO_FECHADO',          'Acordo fechado',       250, 'TERMO',        'DIAS_UTEIS',    2, 'ACOMPANHAR_PAGAMENTO','termo',     false, false, true,  true,  'seed'),
  ('AGUARDANDO_BAIXA',        'Aguardando baixa',     310, 'FINANCEIRO',   'NENHUM',     null, 'CONTATAR',            'financeiro',false, false, true,  true,  'seed'),
  ('BAIXA_REALIZADA',         'Baixa realizada',      320, 'FINANCEIRO',   'NENHUM',     null, 'CONTATAR',            'confirmar', false, false, true,  true,  'seed'),
  ('BAIXA_DEVOLVIDA',         'Baixa devolvida',      330, 'FINANCEIRO',   'NENHUM',     null, 'CONTATAR',            'confirmar', false, false, true,  true,  'seed'),
  ('ELOGIO_ATENDIMENTO',      'Elogio de atendimento',410,'ENCERRAMENTO',  'NENHUM',     null, 'CONTATAR',            null,        false, false, false, true,  'seed'),
  ('CANCELAMENTO_COBRANCA',   'Cancelamento definitivo de cobrança', 420, 'ENCERRAMENTO','NENHUM', null, 'CONTATAR', null,         true,  true,  true,  true,  'seed'),
  ('SUSPENSAO_COBRANCA',      'Suspensão de cobrança',430,'ENCERRAMENTO',  'NENHUM',     null, 'CONTATAR',            null,        true,  true,  true,  true,  'seed'),
  ('JURIDICO',                'Jurídico',             440, 'ENCERRAMENTO', 'NENHUM',     null, 'CONTATAR',            null,        true,  true,  true,  true,  'seed'),
  ('QUITADO_MANUAL',          'Quitado',              450, 'ENCERRAMENTO', 'NENHUM',     null, 'CONTATAR',            null,        false, true,  true,  false, 'seed')
on conflict (codigo) do nothing;

-- ---------------------------------------------------------------------------
-- 3) RLS -- leitura pra autenticado, escrita só via RPC
-- ---------------------------------------------------------------------------
alter table public.tabulacoes enable row level security;

drop policy if exists tabulacoes_leitura_autenticado on public.tabulacoes;
create policy tabulacoes_leitura_autenticado
  on public.tabulacoes for select
  to authenticated
  using (true);

-- Sem policy de insert/update/delete: nem gestão escreve direto. Toda escrita
-- passa pelas RPCs abaixo, que checam usuario_e_gestao().
revoke all on public.tabulacoes from anon;
-- O schema public concede INSERT/UPDATE/DELETE a `authenticated` por padrão.
-- A RLS já barraria (não existe policy de escrita), mas revogamos o privilégio
-- também: duas camadas, e o erro que o operador veria é de permissão, não um
-- update silencioso de 0 linhas -- a mesma armadilha do caso RLS silenciosa em
-- corrigir_cadastro_aluno.
revoke insert, update, delete, truncate, references, trigger
  on public.tabulacoes from authenticated;
grant select on public.tabulacoes to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Impacto -- quem está usando o código hoje
-- ---------------------------------------------------------------------------
-- Usada pela tela ANTES de desativar, pra mostrar exatamente o que continua
-- de pé. Só conta linhas; não devolve nome, CPF nem contato.
create or replace function public.tabulacao_impacto(p_codigo text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'codigo', upper(btrim(p_codigo)),
    'alunos', (select count(*) from public.alunos
                where status_atual = upper(btrim(p_codigo))),
    'alunos_com_retorno_agendado', (select count(*) from public.alunos
                where status_atual = upper(btrim(p_codigo))
                  and data_retorno is not null
                  and data_retorno >= current_date),
    'movimentacoes', (select count(*) from public.aluno_movimentacoes
                where status_novo = upper(btrim(p_codigo)))
  );
$function$;

revoke all on function public.tabulacao_impacto(text) from public, anon;
grant execute on function public.tabulacao_impacto(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Salvar (incluir ou editar)
-- ---------------------------------------------------------------------------
-- Um único ponto de escrita. Insere quando o código não existe, atualiza
-- quando existe. NÃO toca em alunos/casos/data_retorno -- a regra nova vale a
-- partir da próxima tabulação (ver "REGRA CENTRAL" no topo).
create or replace function public.tabulacao_salvar(
  p_codigo               text,
  p_rotulo               text,
  p_grupo                text default 'CONTATO',
  p_retorno_modo         text default 'NENHUM',
  p_retorno_dias_uteis   integer default null,
  p_proxima_acao         text default 'CONTATAR',
  p_bloco_ficha          text default null,
  p_exige_processo       boolean default false,
  p_bloqueia_acionamento boolean default false,
  p_ordem                integer default null
)
returns public.tabulacoes
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_rot   text := btrim(coalesce(p_rotulo,''));
  v_dias  integer := case when p_retorno_modo = 'DIAS_UTEIS' then p_retorno_dias_uteis else null end;
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ordem integer;
  v_row   public.tabulacoes;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Sem permissão: só a gestão pode incluir ou editar tabulações.'
      using errcode = '42501';
  end if;
  if v_cod = '' then
    raise exception 'Informe o código da tabulação.' using errcode = '22023';
  end if;
  if v_rot = '' then
    raise exception 'Informe o rótulo da tabulação.' using errcode = '22023';
  end if;

  -- Ordem: usa a informada, ou joga no fim do grupo (+10 sobre a maior).
  v_ordem := coalesce(
    p_ordem,
    (select coalesce(max(ordem),0) + 10 from public.tabulacoes where grupo = p_grupo),
    500
  );

  insert into public.tabulacoes as t
    (codigo, rotulo, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
     bloco_ficha, exige_processo, bloqueia_acionamento, ordem, ativa, criado_por)
  values
    (v_cod, v_rot, p_grupo, p_retorno_modo, v_dias, p_proxima_acao,
     nullif(btrim(coalesce(p_bloco_ficha,'')),''), p_exige_processo,
     p_bloqueia_acionamento, v_ordem, true, v_email)
  on conflict (codigo) do update set
     rotulo               = excluded.rotulo,
     grupo                = excluded.grupo,
     retorno_modo         = excluded.retorno_modo,
     retorno_dias_uteis   = excluded.retorno_dias_uteis,
     proxima_acao         = excluded.proxima_acao,
     bloco_ficha          = excluded.bloco_ficha,
     exige_processo       = excluded.exige_processo,
     bloqueia_acionamento = excluded.bloqueia_acionamento,
     ordem                = excluded.ordem,
     atualizado_em        = now(),
     atualizado_por       = v_email
  returning t.* into v_row;

  return v_row;
end;
$function$;

revoke all on function public.tabulacao_salvar(text,text,text,text,integer,text,text,boolean,boolean,integer) from public, anon;
grant execute on function public.tabulacao_salvar(text,text,text,text,integer,text,text,boolean,boolean,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Desativar / reativar ("excluir" da tela)
-- ---------------------------------------------------------------------------
-- Desativar tira a opção da lista de tabular e NADA MAIS: quem já está nesse
-- código mantém status, data_retorno e retorno_origem intactos até ser
-- tabulado de novo. Devolve o impacto pra tela poder confirmar o que ficou.
create or replace function public.tabulacao_desativar(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ativas integer;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Sem permissão: só a gestão pode desativar tabulações.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.tabulacoes where codigo = v_cod) then
    raise exception 'Tabulação % não existe.', v_cod using errcode = '02000';
  end if;

  -- Trava mínima: nunca deixar o operador sem nenhuma opção pra tabular.
  select count(*) into v_ativas from public.tabulacoes where ativa and codigo <> v_cod;
  if v_ativas = 0 then
    raise exception 'Não dá pra desativar a última tabulação ativa.' using errcode = '23514';
  end if;

  update public.tabulacoes
     set ativa = false, desativada_em = now(), desativada_por = v_email
   where codigo = v_cod;

  return public.tabulacao_impacto(v_cod) || jsonb_build_object('ativa', false);
end;
$function$;

create or replace function public.tabulacao_reativar(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if not public.usuario_e_gestao() then
    raise exception 'Sem permissão: só a gestão pode reativar tabulações.'
      using errcode = '42501';
  end if;

  update public.tabulacoes
     set ativa = true, desativada_em = null, desativada_por = null,
         atualizado_em = now(), atualizado_por = v_email
   where codigo = v_cod;

  if not found then
    raise exception 'Tabulação % não existe.', v_cod using errcode = '02000';
  end if;

  return public.tabulacao_impacto(v_cod) || jsonb_build_object('ativa', true);
end;
$function$;

revoke all on function public.tabulacao_desativar(text) from public, anon;
revoke all on function public.tabulacao_reativar(text) from public, anon;
grant execute on function public.tabulacao_desativar(text) to authenticated;
grant execute on function public.tabulacao_reativar(text) to authenticated;
