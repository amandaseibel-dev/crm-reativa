-- Agenda Operacional: separar "retorno agendado pela operação" de
-- "data_retorno do motor da fila".
--
-- Problema: alunos.data_retorno acumula três significados diferentes:
--   1) motor da fila -- recalcular_situacao_aluno grava hoje (cobrança
--      vencida), vencimento-2 (acordo em dia) ou último acionamento+10
--      (ação massiva). Em 17/08/2026 isso deixou 12.622 alunos com
--      "retorno hoje" sem ninguém ter agendado nada;
--   2) regra por status no frontend (mensagem enviada +2 úteis etc.);
--   3) retorno que o operador realmente digitou ao tabular.
--
-- A Agenda Operacional lista qualquer data_retorno preenchida, então
-- mostrava os três -- ~12,6 mil "compromissos" onde a operação agendou 26.
--
-- Solução: coluna retorno_origem ('OPERADOR' | 'AUTOMATICO'). A fila
-- operacional continua usando data_retorno exatamente como antes; só a
-- Agenda passa a filtrar retorno_origem = 'OPERADOR'.
--
-- ROLLBACK: nada aqui muda comportamento sozinho -- a coluna é só
-- anotação e nenhuma regra de fila/criticidade/saldo foi tocada. Para
-- voltar atrás basta republicar o frontend anterior (a Agenda volta a
-- listar qualquer data_retorno). Só depois disso é seguro dropar a
-- coluna, porque as funções abaixo escrevem nela.

-- 1) Colunas -----------------------------------------------------------
alter table public.alunos
  add column if not exists retorno_origem text;

alter table public.alunos_unificados
  add column if not exists retorno_origem text;

comment on column public.alunos.retorno_origem is
  'Origem de data_retorno: OPERADOR (agendado ao tabular, aparece na Agenda Operacional) ou AUTOMATICO (motor da fila / ação massiva / regra por status). Null quando não há retorno.';

comment on column public.alunos_unificados.retorno_origem is
  'Espelho de alunos.retorno_origem (sincronizar_alunos_unificados). A Agenda Operacional lista só OPERADOR.';

-- Agenda busca por dia dentro do que foi agendado pela operação.
create index if not exists ix_alunos_unificados_retorno_operador
  on public.alunos_unificados (data_retorno)
  where retorno_origem = 'OPERADOR';

-- O executor técnico tem grant COLUNA A COLUNA (não é grant de tabela):
-- sem isso, qualquer update dele em alunos.data_retorno quebraria no
-- trigger de espelho com "permission denied for column retorno_origem".
grant update (retorno_origem) on public.alunos to reativa_responsavel_executor;
grant update (retorno_origem) on public.alunos_unificados to reativa_responsavel_executor;

-- 2) Retorno sem data não tem origem -----------------------------------
-- Vale para todos os pontos que limpam data_retorno (quitação, saldo zero,
-- redistribuição, liberação de caso) sem precisar editar cada função.
create or replace function public.limpar_retorno_origem()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.data_retorno is null then
    new.retorno_origem := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_alunos_retorno_origem on public.alunos;
create trigger trg_alunos_retorno_origem
  before insert or update of data_retorno, retorno_origem on public.alunos
  for each row execute function public.limpar_retorno_origem();

-- 3) Backfill ----------------------------------------------------------
-- 3.1 Evidência dura de agendamento manual: existe movimentação do
--     operador com retorno na mesma data que está na ficha.
update public.alunos a
   set retorno_origem = 'OPERADOR'
 where a.data_retorno is not null
   and exists (
     select 1 from public.aluno_movimentacoes m
      where m.aluno_id = a.id::text
        and m.data_retorno::date = a.data_retorno);

-- 3.2 Retorno FUTURO de cobrança vencida, fora de ação massiva: não dá
--     pra provar a origem (a tabulação da Minha Carteira não grava
--     data_retorno na movimentação). Conservador: mantém na Agenda.
update public.alunos a
   set retorno_origem = 'OPERADOR'
 where a.retorno_origem is null
   and a.data_retorno > current_date
   and coalesce(a.status_acionamento, '') not ilike 'Ação massiva%'
   and coalesce(a.situacao_operacional, '') <> 'ACORDO_EM_DIA';

-- 3.3 Todo o resto é motor da fila.
update public.alunos
   set retorno_origem = 'AUTOMATICO'
 where data_retorno is not null
   and retorno_origem is null;

update public.alunos_unificados u
   set retorno_origem = a.retorno_origem
  from public.alunos a
 where a.chave_unificacao = u.chave_unificacao
   and a.chave_unificacao is not null;

-- 4) Espelho alunos -> alunos_unificados --------------------------------
create or replace function public.sincronizar_alunos_unificados()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.chave_unificacao is null then
    return new;
  end if;

  update public.alunos_unificados
  set
    data_retorno = new.data_retorno,
    retorno_origem = new.retorno_origem,
    hora_retorno = nullif(new.hora_retorno, '')::time,
    status_jornada = new.status_jornada,
    operador_nome = coalesce(new.responsavel_atual_nome, new.operador_nome, new.operador, operador_nome),
    operador_email = coalesce(new.responsavel_atual_email, new.operador_email, operador_email),
    ultima_interacao_em = now()
  where chave_unificacao = new.chave_unificacao;

  return new;
end;
$function$;

-- retorno_origem entra na lista de colunas que disparam o espelho.
drop trigger if exists trg_sincronizar_alunos_unificados on public.alunos;
create trigger trg_sincronizar_alunos_unificados
  after insert or update of data_retorno, retorno_origem, hora_retorno,
    status_jornada, operador_nome, operador_email, operador,
    responsavel_atual_nome, responsavel_atual_email
  on public.alunos
  for each row execute function public.sincronizar_alunos_unificados();

-- 5) Motor da fila marca o que ele mesmo agendou ------------------------
-- Regra: o recálculo NUNCA rebaixa OPERADOR -> AUTOMATICO. Só a ação
-- massiva e o acompanhamento de acordo em dia (que reescrevem a data)
-- marcam AUTOMATICO. Assim o compromisso do operador continua na Agenda
-- no dia marcado -- e continua visível se ele não cumprir -- até a
-- próxima tabulação.
CREATE OR REPLACE FUNCTION public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hoje date := current_date;
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'),'{}'::jsonb);
  v_ant int := coalesce((select (valor->>'dias')::int from public.calibragem_parametros where chave='retorno_antecedencia_dias'),2);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int,5);
  v_fim_mes boolean := (date_trunc('month',now())+interval '1 month - 1 day')::date - hoje <= v_fim_mes_dias;
  v_parc_venc_val numeric := 0; v_parc_fut_val numeric := 0;
  v_venc_qtd int := 0; v_fut_qtd int := 0;
  v_parc_antiga_venc date;
  v_prox_venc date; v_prox_val numeric;
  v_entrada_pend boolean := false;
  v_tit_val numeric := 0; v_tit_venc_val numeric := 0;
  v_conf_pend int := 0;
  v_termo_pend boolean := false;
  v_baixa_pend boolean := false;
  v_tem_acordo boolean := false;
  v_saldo_vencido numeric; v_saldo_total numeric;
  v_dias_venc int := 0; v_dias_sem_ac int;
  v_status_acion text; v_ult_acion date; v_acao_massiva boolean := false;
  v_ret_atual date; v_orig_atual text;
  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;
begin
  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;

  select
    coalesce(sum(p.valor) filter (where p.vencimento <  hoje),0),
    coalesce(sum(p.valor) filter (where p.vencimento >= hoje),0),
    count(*) filter (where p.vencimento <  hoje),
    count(*) filter (where p.vencimento >= hoje),
    min(p.vencimento) filter (where p.vencimento < hoje),
    bool_or(p.is_entrada),
    count(*) > 0
  into v_parc_venc_val, v_parc_fut_val, v_venc_qtd, v_fut_qtd, v_parc_antiga_venc, v_entrada_pend, v_tem_acordo
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    and p.vencimento >= hoje
  order by p.vencimento asc, p.numero asc
  limit 1;

  select
    coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
    coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < hoje),0)
  into v_tit_val, v_tit_venc_val
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id
    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  select count(*) into v_conf_pend
  from public.solicitacoes_confirmacao_pagamento
  where aluno_id=p_aluno_id::text and status='AGUARDANDO_CONFIRMACAO';

  select coalesce((c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);

  select coalesce((al.status_baixa_pagamento is not null and al.status_baixa_pagamento <> 'BAIXA_REALIZADA'), false)
  into v_baixa_pend from public.alunos al where al.id=p_aluno_id;
  v_baixa_pend := coalesce(v_baixa_pend,false);

  v_saldo_vencido := round(v_parc_venc_val + v_tit_venc_val, 2);
  v_saldo_total   := round(v_parc_venc_val + v_parc_fut_val + v_tit_val, 2);

  v_dias_venc := case
    when v_parc_antiga_venc is not null then (hoje - v_parc_antiga_venc)
    else coalesce((select hoje - min(t.vencimento) from public.acordos_titulos t
                   where t.aluno_id=p_aluno_id and t.vencimento < hoje
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                     and coalesce(lower(t.status),'') not in ('quitada')
                     and not exists (
                       select 1 from public.acordo_titulo_vinculo v
                       join public.acordos a on a.id=v.acordo_id
                       where v.titulo_id=t.id and coalesce(v.ativo,true)
                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
                     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  -- Último acionamento, se veio de ação massiva (aguardando retorno) e o
  -- retorno já gravado hoje na ficha (o operador pode tê-lo acabado de agendar).
  select
    case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end,
    data_ultimo_acionamento::date,
    coalesce(status_acionamento,'') ilike 'Ação massiva%',
    data_retorno,
    retorno_origem
  into v_dias_sem_ac, v_ult_acion, v_acao_massiva, v_ret_atual, v_orig_atual
  from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  if v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     else
        v_situacao := 'QUITADO';
        v_proxima  := null;
     end if;
     v_retorno := null; v_origem := null;
  elsif v_conf_pend > 0 and v_saldo_vencido <= 0.005 then
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'ATENCAO');
     v_proxima := 'Próxima ação: confirmar o pagamento no financeiro.';
     v_retorno := null; v_origem := null;
  elsif v_saldo_vencido > 0.005 then
     v_nivel := public.calibragem_nivel_criticidade(v_dias_venc, v_dias_sem_ac, v_saldo_total, v_termo_pend, v_fim_mes, v_regras);
     v_situacao := 'COBRANCA_VENCIDA';
     v_proxima := 'Próxima ação: cobrar o saldo vencido de '||public.fmt_brl(v_saldo_vencido)||'.';
     -- Retorno agendado é RESPEITADO: o aluno sai da fila operacional até lá.
     --   1) Ação massiva agenda +10 dias e é respeitada dentro da janela.
     --   2) Retorno FUTURO na ficha (agendado pelo operador ao tabular) manda
     --      o caso pra data marcada, em vez de voltar pro topo hoje.
     --   3) Sem retorno futuro: cobrança vencida continua vencendo hoje.
     if v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then
        v_retorno := v_ult_acion + 10;
        v_origem  := 'AUTOMATICO';
     elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        -- Data do operador preservada: mantém a origem que já estava lá.
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        -- Compromisso do operador que venceu hoje (ou ficou pra trás)
        -- continua na Agenda até ele tabular de novo.
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     end if;
  elsif v_parc_fut_val > 0.005 and v_prox_venc is not null then
     v_nivel := 'NORMAL';
     v_situacao := 'ACORDO_EM_DIA';
     v_proxima := 'Próxima ação: acompanhar a parcela de '||public.fmt_brl(coalesce(v_prox_val,0))
                ||' com vencimento em '||to_char(v_prox_venc,'DD/MM/YYYY')||'.';
     v_retorno := greatest(hoje, v_prox_venc - v_ant);
     -- Acompanhamento de parcela é do sistema, não é compromisso agendado.
     v_origem := 'AUTOMATICO';
  else
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'NORMAL');
     v_situacao := 'SEM_PENDENCIA';
     v_proxima := null;
     v_retorno := null; v_origem := null;
  end if;

  update public.casos set
     criticidade            = v_nivel,
     situacao_operacional   = v_situacao,
     proxima_acao_automatica= v_proxima,
     proximo_vencimento     = coalesce(v_prox_venc, v_parc_antiga_venc, proximo_vencimento),
     parcela_a_vencer       = v_prox_val,
     parcelas_vencidas      = v_venc_qtd,
     saldo_vencido          = v_saldo_vencido,
     saldo_total            = v_saldo_total,
     data_retorno           = v_retorno,
     caso_atualizado_em     = now()
   where aluno_id = p_aluno_id;

  update public.alunos set
     nivel_criticidade    = v_nivel,
     situacao_operacional = v_situacao,
     proxima_acao         = v_proxima,
     saldo_vencido        = v_saldo_vencido,
     saldo_total          = v_saldo_total,
     data_retorno         = v_retorno,
     retorno_origem       = v_origem
   where id = p_aluno_id;

  if v_situacao='ACORDO_EM_DIA' and v_prox_venc is not null then
     insert into public.retorno_acordo_auto(aluno_id, proximo_vencimento, data_retorno, valor, lote)
     values (p_aluno_id, v_prox_venc, v_retorno, v_prox_val, coalesce(p_lote,'evento'))
     on conflict (aluno_id, proximo_vencimento)
       do update set data_retorno=excluded.data_retorno, valor=excluded.valor, gerado_em=now();
  end if;

  return jsonb_build_object(
    'aluno_id',p_aluno_id,'situacao',v_situacao,'criticidade',v_nivel,
    'proxima_acao',v_proxima,'data_retorno',v_retorno,'retorno_origem',v_origem,
    'saldo_vencido',v_saldo_vencido,'saldo_total',v_saldo_total,
    'proxima_parcela_venc',v_prox_venc,'proxima_parcela_valor',v_prox_val,
    'confirmacao_pendente',v_conf_pend>0,'termo_pendente',v_termo_pend,
    'entrada_pendente',coalesce(v_entrada_pend,false),'baixa_pendente',v_baixa_pend,
    'tem_acordo',coalesce(v_tem_acordo,false));
end; $function$;

-- 6) Ação massiva: retorno +10 dias é do sistema ------------------------
CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(p_aluno_ids text[], p_canal text, p_arquivo text, p_registrado_por_nome text, p_registrado_por_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_id text;
  v_retorno date := (current_date + 10);
  v_agora timestamptz := now();
  v_tipo text := CASE WHEN p_canal = 'WHATSAPP' THEN 'ACAO_MASSIVA_EXTERNA' ELSE 'ACAO_MASSIVA_EXTERNA_EMAIL' END;
  v_registrados text[] := '{}';
  v_excluidos_conf int := 0; v_excluidos jsonb := '[]'::jsonb; v_mov int := 0;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
  v_autor_email text; v_autor_nome text; v_contatos jsonb;
  v_conf_ids text[];
BEGIN
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' USING ERRCODE = '42501';
  END IF;

  IF v_sistema THEN
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  ELSE
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name',''), v_autor_email);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT cid), '{}') INTO v_conf_ids
  FROM (
    SELECT s.aluno_id::text AS cid
      FROM public.solicitacoes_confirmacao_pagamento s
     WHERE s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
       AND s.aluno_id = ANY(COALESCE(p_aluno_ids, '{}'::text[]))
    UNION
    SELECT a.id::text
      FROM public.alunos a
     WHERE a.id = ANY(COALESCE(p_aluno_ids, '{}'::text[])::uuid[])
       AND public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
  ) u;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_conf_ids) THEN
      v_excluidos_conf := v_excluidos_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Aguardando confirmação financeira');
      CONTINUE;
    END IF;

    UPDATE public.alunos
       SET data_retorno = v_retorno,
           retorno_origem = 'AUTOMATICO',
           status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_ultimo_acionamento = v_agora
     WHERE id = v_id::uuid AND responsavel_atual_email IS NULL;

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '), sem operador vinculado. Retorno agendado para ' || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        v_autor_nome, v_autor_email, v_agora);
      v_mov := v_mov + 1; v_registrados := v_registrados || v_id;
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso com operador vinculado ou inexistente');
    END IF;
  END LOOP;

  v_contatos := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    FROM public.alunos a WHERE a.id = ANY(v_registrados::uuid[])), '[]'::jsonb);

  RETURN jsonb_build_object(
    'registrados', COALESCE(array_length(v_registrados, 1), 0),
    'ids_registrados', to_jsonb(v_registrados),
    'excluidos_confirmacao', v_excluidos_conf,
    'movimentacoes_criadas', v_mov,
    'autor_email', v_autor_email,
    'executado_por', CASE WHEN v_sistema THEN 'SISTEMA' ELSE 'USUARIO' END,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
END;
$function$;

-- 7) Retorno do financeiro devolve o caso hoje: é do sistema ------------
CREATE OR REPLACE FUNCTION public.financeiro_registrar_retorno(p_solicitacao_id uuid, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_email      text := lower(coalesce(auth.email(), ''));
  v_aluno_id   text;
  v_aluno_nome text;
  v_operador   text;
  v_dest       text;
  v_aluno_uuid uuid;
begin
  if v_email not in (
    'cobranca07@aelbra.com.br',
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br'
  ) then
    raise exception 'Sem permissao para registrar retorno do financeiro.'
      using errcode = '42501';
  end if;

  if p_texto is null or btrim(p_texto) = '' then
    raise exception 'Informe o texto do retorno do financeiro.';
  end if;

  update public.solicitacoes_financeiro
     set status = 'RETORNADO_FINANCEIRO',
         retorno_financeiro = btrim(p_texto),
         retorno_em = now(),
         retorno_por = v_email,
         atualizado_em = now()
   where id = p_solicitacao_id
   returning aluno_id, aluno_nome, operador_email
     into v_aluno_id, v_aluno_nome, v_operador;

  if v_aluno_id is null then
    raise exception 'Solicitacao financeira nao encontrada.';
  end if;

  update public.alunos
     set status_atual = 'Retorno do financeiro recebido',
         status_jornada = 'Retorno do financeiro recebido',
         status_acionamento = 'Retorno do financeiro recebido',
         proxima_acao = 'RETORNAR',
         data_retorno = now(),
         retorno_origem = 'AUTOMATICO',
         atualizado_em = now()
   where id::text = v_aluno_id;

  begin v_aluno_uuid := v_aluno_id::uuid; exception when others then v_aluno_uuid := null; end;

  if v_aluno_uuid is not null then
    select responsavel_atual_email into v_dest
      from public.alunos where id = v_aluno_uuid;
  end if;
  if v_dest is null or btrim(v_dest) = '' then
    v_dest := v_operador;
  end if;

  insert into public.aluno_movimentacoes(
    aluno_id, tipo, descricao, status_novo,
    registrado_por_nome, registrado_por_email, registrado_em
  ) values (
    v_aluno_id, 'RETORNO_FINANCEIRO',
    'Retorno do financeiro: ' || btrim(p_texto),
    'Retorno do financeiro recebido',
    'Financeiro (ADM)', v_email, now()
  );

  if v_dest is not null and btrim(v_dest) <> '' then
    insert into public.notificacoes(
      usuario_destino_email, tipo, titulo, mensagem,
      aluno_id, url_destino, lida, criado_em
    ) values (
      lower(v_dest), 'RETORNO_FINANCEIRO',
      '💰 Retorno do financeiro',
      'O financeiro respondeu' || coalesce(' o caso de ' || v_aluno_nome, '') ||
        '. Abra o caso para ver a resposta e dar sequencia.',
      v_aluno_id, '/aluno', false, now()
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'aluno_id', v_aluno_id,
    'notificado', v_dest
  );
end
$function$;

-- 8) Base receptiva: data digitada pelo operador ------------------------
CREATE OR REPLACE FUNCTION public.sistema_assumir_receptivo(p_aluno_id uuid, p_status text, p_observacao text, p_data_retorno date DEFAULT NULL::date, p_hora_retorno text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text; v_n int; v_dono text; v_dono_nome text;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  if coalesce(btrim(p_observacao),'')='' then return jsonb_build_object('ok',false,'erro','OBSERVACAO_OBRIGATORIA'); end if;
  if public.caso_saldo_zerado_real(p_aluno_id, null) then
    perform internal.encaminhar_saldo_zerado_confirmacao(p_aluno_id);
    return jsonb_build_object('ok',false,'erro','SALDO_ZERADO',
      'mensagem','Este aluno esta sem saldo em aberto. Encaminhado para Confirmacao de Pagamentos; nao entra na carteira de cobranca.');
  end if;

  update public.alunos set operador_nome=v_nome, operador_email=v_email, operador=v_nome,
      status_jornada=p_status, status_atual=p_status, status_acionamento=p_status,
      data_retorno=p_data_retorno, hora_retorno=p_hora_retorno, observacao=p_observacao,
      retorno_origem = case when p_data_retorno is null then null else 'OPERADOR' end,
      origem='Base receptiva', tipo_base='RECEPTIVA', atualizado_em=now()
   where id=p_aluno_id
     and not (
          status_jornada = 'EM_ATENDIMENTO'
      and responsavel_atual_email is not null
      and lower(responsavel_atual_email) <> v_email
      and atualizado_em > now() - interval '2 hours'
     );
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select responsavel_atual_email, responsavel_atual_nome into v_dono, v_dono_nome
      from public.alunos where id=p_aluno_id;
    return jsonb_build_object('ok',false,'erro','JA_EM_ATENDIMENTO',
      'por', coalesce(v_dono_nome, v_dono, 'outro operador'),
      'mensagem','Este aluno ja esta em atendimento por '||coalesce(v_dono_nome, v_dono, 'outro operador')||'. Atualize a lista da base receptiva.');
  end if;

  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva. Origem: assumir_receptivo.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$;
