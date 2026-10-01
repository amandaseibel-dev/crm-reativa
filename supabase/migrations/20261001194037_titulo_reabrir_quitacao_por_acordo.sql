-- G2 / etapa 3 de 4 -- A PORTA EXPLICITA PARA DESFAZER A QUITACAO POR ACORDO
--
-- titulo_reavaliar RETORNA NA SEGUNDA INSTRUCAO para PAGO/quitada:
--
--     if upper(coalesce(v_situacao,'')) = 'PAGO'
--        or lower(coalesce(v_status,'')) in ('quitada','paga') then
--       return;
--     end if;
--
-- Isso continua valendo: PAGO e terminal para o motor, e ele segue com UMA UNICA
-- ASSINATURA, titulo_reavaliar(uuid). Nao se acrescenta parametro com default --
-- isso criaria uma segunda assinatura e as chamadas titulo_reavaliar($1) dos
-- quatro gatilhos passariam a falhar com "function is not unique" em runtime.
--
-- O proprio comentario do motor ja previa a saida: "Voltar a cobrar exige um
-- caminho explicito, que hoje nao existe -- e quando existir sera um 'desfazer'
-- com registro". Esta funcao e esse caminho, e e o UNICO.
--
-- NOVE GUARDAS CUMULATIVAS (G0..G7, com G1 cobrindo o par de colunas). Qualquer
-- uma falha -> excecao e zero escrita. Note que a porta SIM confere tipo_boleto,
-- ao contrario do motor: reabrir o boleto do proprio acordo nunca faz sentido,
-- ele nunca foi divida.
--
-- ARMADILHA QUE ESTA FUNCAO EVITA: _titulo_situacao_e_status_coerentes (BEFORE)
-- comeca com
--     if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
--       new.situacao := 'PAGO';
-- Um update que mexa SO em `situacao` e revertido EM SILENCIO para PAGO/quitada:
-- sem erro, sem linha alterada de fato. Por isso o update aqui grava o PAR.

create or replace function public.titulo_reabrir_quitacao_por_acordo(p_titulo uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_t record; v_acordo uuid; v_ac_status text; v_ac_numero bigint;
  v_parc_vivas int; v_motivo text; v_depois record;
begin
  -- G0: portao da gestao financeira. Backend (sem claim) passa; operador logado
  -- comum nao. Mesmo portao da reconciliacao de 30/09.
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  select * into v_t from public.acordos_titulos where id = p_titulo for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO' using errcode = '22000';
  end if;

  -- G1: so desfaz o que esta de fato quitado, e pelo PAR de colunas.
  if upper(coalesce(v_t.situacao,'')) <> 'PAGO'
     or lower(coalesce(v_t.status,'')) <> 'quitada' then
    raise exception 'NAO_ESTA_QUITADO: situacao=% status=%',
      coalesce(v_t.situacao,'(null)'), coalesce(v_t.status,'(null)') using errcode = '22000';
  end if;

  -- G2: a proveniencia MANDA. Sem marca, nao se sabe por que fechou -- nao reabre.
  -- PRIME_LIQUIDACAO_OFICIAL e terminal e nao passa por aqui em nenhuma hipotese.
  if coalesce(v_t.origem_liquidacao,'') <> 'ACORDO_QUITADO' then
    raise exception 'ORIGEM_NAO_REABRIVEL: origem_liquidacao=%',
      coalesce(v_t.origem_liquidacao,'(null)') using errcode = '22000';
  end if;

  -- G3: saida administrativa (Conferencia Prime) tem porta propria.
  if v_t.origem_encerramento is not null then
    raise exception 'ENCERRADO_ADMINISTRATIVAMENTE: %', v_t.origem_encerramento using errcode = '22000';
  end if;

  -- G4: boleto do proprio acordo nunca foi divida -- e o numero do documento.
  if coalesce(v_t.tipo_boleto,'') = 'Acordo' then
    raise exception 'TITULO_DE_ACORDO' using errcode = '22000';
  end if;

  -- G5: precisa de vinculo vivo para acordo nao cancelado -- mesma consulta do motor.
  select v.acordo_id, upper(coalesce(a.status,'')), a.numero_acordo
    into v_acordo, v_ac_status, v_ac_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  if v_acordo is null then
    raise exception 'SEM_VINCULO_VIVO' using errcode = '22000';
  end if;

  -- G6: acordo ainda QUITADO nao reabre nada. A divida foi paga.
  if v_ac_status = 'QUITADO' then
    raise exception 'ACORDO_AINDA_QUITADO' using errcode = '22000';
  end if;

  -- G7: so reabre se sobrou divida DE VERDADE no acordo. Zero parcela viva
  -- significa que a quitacao tem lastro, mesmo com o acordo fora de QUITADO.
  select count(*) into v_parc_vivas
    from public.parcelas p
   where p.acordo_id = v_acordo
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA');

  if v_parc_vivas = 0 then
    raise exception 'ACORDO_SEM_PARCELA_VIVA: a quitacao tem lastro' using errcode = '22000';
  end if;

  v_motivo := 'quitacao por acordo desfeita em '
    || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')
    || ': o acordo ' || coalesce(v_ac_numero::text, '?') || ' esta ' || v_ac_status
    || ' com ' || v_parc_vivas::text || ' parcela(s) viva(s), logo a divida desta '
    || 'mensalidade nao foi paga';

  -- O PAR INTEIRO num unico update (ver a armadilha no cabecalho). A trinca volta
  -- a NULL porque, depois daqui, o titulo NAO esta liquidado -- manter a marca
  -- seria registrar o contrario do fato.
  update public.acordos_titulos
     set situacao = 'NEGOCIADO',
         status   = 'vinculada',
         acordo_id = v_acordo,
         origem_liquidacao     = null,
         origem_liquidacao_ref = null,
         origem_liquidacao_em  = null,
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || v_motivo,
         atualizado_em = now()
   where id = p_titulo;

  -- PASSE DE CONFIRMACAO: o motor agora atravessa a porta (nao e mais PAGO) e
  -- reavalia de forma independente. Se ele chegar a OUTRA decisao, a premissa
  -- estava errada e a transacao morre aqui.
  perform public.titulo_reavaliar(p_titulo);

  select situacao, status, acordo_id into v_depois
    from public.acordos_titulos where id = p_titulo;

  if upper(coalesce(v_depois.situacao,'')) <> 'NEGOCIADO'
     or lower(coalesce(v_depois.status,'')) <> 'vinculada' then
    raise exception 'MOTOR_DISCORDOU: apos titulo_reavaliar o titulo ficou %/%',
      coalesce(v_depois.situacao,'(null)'), coalesce(v_depois.status,'(null)') using errcode = '22000';
  end if;

  insert into public.mensalidade_reconciliacao_log
    (lote, titulo_id, aluno_id, acordo_id, numero_acordo, documento, valor_original,
     situacao_antes, status_antes, situacao_depois, status_depois, motivo, executado_por)
  values
    ('REABRIR_QUITACAO_POR_ACORDO', p_titulo, v_t.aluno_id, v_acordo, v_ac_numero,
     v_t.documento, v_t.valor_original,
     v_t.situacao, v_t.status, v_depois.situacao, v_depois.status, v_motivo,
     coalesce(auth.jwt() ->> 'email', current_user));

  return jsonb_build_object(
    'ok', true,
    'titulo_id', p_titulo,
    'acordo_id', v_acordo,
    'acordo_status', v_ac_status,
    'parcelas_vivas', v_parc_vivas,
    'situacao', v_depois.situacao,
    'status', v_depois.status);
end;
$function$;

comment on function public.titulo_reabrir_quitacao_por_acordo(uuid) is
  'UNICO caminho explicito para tirar um titulo de PAGO/quitada quando a origem e ACORDO_QUITADO (01/10/2026). Nove guardas cumulativas, grava o par de colunas, limpa a trinca, chama titulo_reavaliar como passe de confirmacao e registra em mensalidade_reconciliacao_log. PRIME_LIQUIDACAO_OFICIAL nunca passa por aqui.';

-- SEM REVOKE. Funcao nova nasce com EXECUTE para authenticated neste projeto, e
-- revogar derrubaria a chamada para a PROPRIA gestao (erro ja cometido em
-- 12/09/2026). A restricao e o portao INTERNO G0, crm_usuario_pode_quitar_baixar().
