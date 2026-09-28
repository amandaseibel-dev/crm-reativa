-- Automacao da coleta do portador 202, com conferencia do PROPRIO ciclo.
--
-- Duas rotinas, nenhuma delas tocando a cadencia de 166/195:
--
--   08h40 UTC  prime_portador_202_rotina()        dispara a coleta
--   08h55 UTC  prime_portador_202_conferir_ciclo() confere o desfecho
--
-- POR QUE A CONFERENCIA EXISTE (Amanda, 24/09/2026): "nao quero que uma coleta
-- disparada as 08h40 so seja classificada como sucesso ou falha na execucao do
-- dia seguinte". A Edge e assincrona -- o disparo devolve um `request_id` e vai
-- embora --, entao sem uma segunda passada o desfecho do ciclo ficaria 24h no
-- escuro. 15 minutos e folga larga: a varredura completa do 202 levou 3
-- segundos (72 CPFs, 146 matriculas, 1 pagina).
--
-- A CONFERENCIA NAO CONSERTA NADA E NAO MARCA NADA COMO VALIDO. A validade do
-- snapshot continua sendo DERIVADA por `prime_portador_snapshot_estado` a
-- partir do cursor e das linhas; em falha, o snapshot simplesmente segue
-- invalido e `prime_aluno_no_juridico` segue devolvendo INDETERMINADO. Nunca
-- ha um carimbo de "valido" que alguem possa escrever a mao.
--
-- JANELA. 08h40 UTC = 05h40 BRT. Escolhida por exclusao: `prime_varredura_nome`
-- ocupa */2 das 0h as 8h UTC chamando a MESMA API; o mutirao de portador roda
-- sabado 0h-1h; 08h20 e 09h10 ja tem job. Sobra 08h40, e a conferencia as
-- 08h55 ainda cabe antes do vigia das 09h10.

-- A auxiliar de auditoria passa a nomear os dois desfechos do ciclo.
create or replace function public._prime_portador_202_auditar(
  p_usuario text,
  p_resultado text,
  p_motivo text,
  p_request_id bigint,
  p_estado jsonb
)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (
    coalesce(nullif(btrim(p_usuario),''), '(sem usuario)'),
    case p_resultado
      when 'DISPARADA' then 'PRIME_PORTADOR_202_COLETA_DISPARADA'
      when 'CONCLUIDA' then 'PRIME_PORTADOR_202_COLETA_CONCLUIDA'
      when 'FALHOU'    then 'PRIME_PORTADOR_202_COLETA_FALHOU'
      else 'PRIME_PORTADOR_202_COLETA_RECUSADA'
    end,
    'prime_portador_membro',
    null,
    jsonb_build_object(
      'portador', 202,
      'resultado', p_resultado,
      'motivo', p_motivo,
      'request_id', p_request_id,
      'estado', p_estado,
      'em', now()
    )
  );
$function$;

-- 1) A ROTINA. Sem parametro: portador 202 e fixo no nucleo, e nao ha como
--    pedir 166, 195 ou qualquer outro por aqui.
create or replace function public.prime_portador_202_rotina()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_recente int;
  v_estado jsonb;
begin
  -- Trava de concorrencia. `xact` e nao de sessao: solta sozinha no fim da
  -- transacao, entao um erro no meio nunca deixa o cadeado preso.
  if not pg_try_advisory_xact_lock(hashtextextended('prime_portador_202_rotina', 0)) then
    return jsonb_build_object('ok', false, 'motivo', 'ROTINA_JA_EM_EXECUCAO');
  end if;

  -- Disparo duplicado: a varredura do 202 fecha em segundos, entao dois
  -- disparos na mesma janela so somariam chamada a API sem ganho.
  select count(*) into v_recente
    from public.auditoria
   where acao = 'PRIME_PORTADOR_202_COLETA_DISPARADA'
     and created_at > now() - interval '10 minutes';
  if v_recente > 0 then
    v_estado := jsonb_build_object('disparos_ultimos_10min', v_recente);
    perform public._prime_portador_202_auditar('cron@sistema', 'RECUSADA', 'DISPARO_RECENTE', null, v_estado);
    return jsonb_build_object('ok', false, 'motivo', 'DISPARO_RECENTE');
  end if;

  -- O nucleo ja trata carga, segredo, erro de enfileiramento e auditoria.
  return public._prime_portador_202_disparar('cron@sistema', false);
end;
$function$;

revoke all on function public.prime_portador_202_rotina() from public;
revoke all on function public.prime_portador_202_rotina() from anon;
revoke all on function public.prime_portador_202_rotina() from authenticated;
grant execute on function public.prime_portador_202_rotina() to postgres, service_role;

-- 2) A CONFERENCIA DO CICLO. So observa e registra.
create or replace function public.prime_portador_202_conferir_ciclo()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req bigint; v_disparo_em timestamptz;
  v_status int; v_conteudo text; v_erro_http text; v_tem_resposta boolean := false;
  v_estado jsonb; v_motivo text; v_coletado timestamptz;
begin
  -- O disparo desta janela. 12h cobre o ciclo do dia sem alcancar o de ontem.
  select (a.detalhes->>'request_id')::bigint, a.created_at
    into v_req, v_disparo_em
    from public.auditoria a
   where a.acao = 'PRIME_PORTADOR_202_COLETA_DISPARADA'
     and a.created_at > now() - interval '12 hours'
   order by a.created_at desc
   limit 1;

  -- 24h de tolerancia: o que interessa e o ciclo de HOJE, nao um snapshot
  -- velho que por acaso ainda esteja dentro do limite generico de 720h.
  v_estado := public.prime_portador_snapshot_estado(202, 24);
  v_coletado := nullif(v_estado->>'coletado_em','')::timestamptz;

  if v_req is null then
    v_motivo := 'SEM_DISPARO_NO_CICLO';
  else
    select r.status_code, left(coalesce(r.content,''), 400), r.error_msg, true
      into v_status, v_conteudo, v_erro_http, v_tem_resposta
      from net._http_response r where r.id = v_req;

    if v_tem_resposta and (coalesce(v_status, 0) >= 400 or v_erro_http is not null) then
      v_motivo := 'ERRO_HTTP';
    elsif v_tem_resposta and v_conteudo ilike '%"erro"%' then
      -- a Edge responde 200 com corpo de erro em alguns caminhos
      v_motivo := 'ERRO_EDGE';
    elsif (v_estado->>'motivo') = 'CICLO_INCOMPLETO' then
      v_motivo := 'CICLO_INCOMPLETO';
    elsif not coalesce((v_estado->>'valido')::boolean, false) then
      v_motivo := 'SNAPSHOT_INVALIDO:' || coalesce(v_estado->>'motivo','?');
    elsif v_coletado is null or v_coletado < v_disparo_em then
      -- snapshot valido, mas de uma coleta ANTERIOR a este disparo: o ciclo de
      -- hoje nao chegou a gravar.
      v_motivo := 'COLETA_NAO_CORRESPONDE_AO_CICLO';
    end if;
  end if;

  if v_motivo is null then
    perform public._prime_portador_202_auditar('cron@sistema', 'CONCLUIDA', null, v_req,
      v_estado || jsonb_build_object('disparo_em', v_disparo_em, 'http_status', v_status));
    return jsonb_build_object('ok', true, 'resultado', 'CONCLUIDA', 'request_id', v_req);
  end if;

  perform public._prime_portador_202_auditar('cron@sistema', 'FALHOU', v_motivo, v_req,
    v_estado || jsonb_build_object('disparo_em', v_disparo_em, 'http_status', v_status,
                                   'resposta', left(coalesce(v_conteudo,''), 300)));
  return jsonb_build_object('ok', false, 'resultado', 'FALHOU', 'motivo', v_motivo, 'request_id', v_req);
end;
$function$;

revoke all on function public.prime_portador_202_conferir_ciclo() from public;
revoke all on function public.prime_portador_202_conferir_ciclo() from anon;
revoke all on function public.prime_portador_202_conferir_ciclo() from authenticated;
grant execute on function public.prime_portador_202_conferir_ciclo() to postgres, service_role;

-- 3) OS CRONS. Dedicados; o mutirao de 166/195 nao e tocado.
select cron.unschedule('prime_portador_202_diario')
 where exists (select 1 from cron.job where jobname = 'prime_portador_202_diario');
select cron.unschedule('prime_portador_202_conferir')
 where exists (select 1 from cron.job where jobname = 'prime_portador_202_conferir');

select cron.schedule('prime_portador_202_diario',   '40 8 * * *', 'select public.prime_portador_202_rotina();');
select cron.schedule('prime_portador_202_conferir', '55 8 * * *', 'select public.prime_portador_202_conferir_ciclo();');
