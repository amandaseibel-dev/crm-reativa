-- quitar_e_encerrar_caso: passa a quitar TAMBEM o acordo e as parcelas
-- (antes so mexia em casos/alunos/titulos, deixando o acordo ATIVO com saldo
-- -> divida invisivel fora da fila) e passa a BLOQUEAR quando ha acordo em dia
-- com parcelas futuras e nada vencido (encerrar por cima de acordo vigente
-- quase sempre e engano). Para prosseguir nesse caso, o chamador precisa
-- passar p_confirmar_acordo_em_dia = true (confirmacao explicita no front).
--
-- NAO faz backfill dos casos ja encerrados: apenas redefine a funcao.

CREATE OR REPLACE FUNCTION public.quitar_e_encerrar_caso(
  p_aluno_id uuid,
  p_valor numeric DEFAULT NULL::numeric,
  p_data date DEFAULT CURRENT_DATE,
  p_confirmar_acordo_em_dia boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_nome text;
  v_aluno_text text := p_aluno_id::text;
  v_casos int := 0;
  v_parc_venc numeric := 0;
  v_parc_fut  numeric := 0;
  v_acordos int := 0;
  v_parcelas int := 0;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
    raise exception 'Sem permissao para quitar/encerrar (apenas Amanda gestora, Fernanda ou Amanda ADM).';
  end if;

  select responsavel_atual_nome into v_nome from public.alunos where id = p_aluno_id;

  -- Trava: acordo em dia (parcelas futuras, nada vencido) nao pode ser
  -- encerrado por engano. Exige confirmacao explicita.
  select
    coalesce(sum(p.valor) filter (where p.vencimento <  p_data),0),
    coalesce(sum(p.valor) filter (where p.vencimento >= p_data),0)
  into v_parc_venc, v_parc_fut
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  where a.aluno_id = p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  if v_parc_fut > 0.005 and v_parc_venc <= 0.005 and not p_confirmar_acordo_em_dia then
    raise exception 'ACORDO_EM_DIA: este aluno tem um acordo vigente com % em parcelas futuras e nada vencido. Encerrar aqui vai quitar o acordo inteiro. Se o aluno realmente pagou tudo, confirme para prosseguir.',
      public.fmt_brl(v_parc_fut)
      using errcode = 'P0001';
  end if;

  update public.casos
  set status_financeiro='QUITADO_CONFIRMACAO', status_atual='QUITADO', quitado_em=p_data,
      valor_quitado=coalesce(p_valor, valor_quitado, 0), total_em_aberto=0, origem_quitacao='QUITADO_DA_FILA',
      caso_atualizado_por=v_email, caso_atualizado_em=now()
  where aluno_id = p_aluno_id;
  get diagnostics v_casos = row_count;

  update public.alunos
  set status_atual='QUITADO', status_acionamento='QUITADO', status_jornada='QUITADO',
      valor_em_aberto=0, saldo_vencido=0, saldo_total=0, fila_destino=null, proxima_acao=null
  where id = p_aluno_id;

  -- Quita as parcelas ainda em aberto dos acordos ATIVOS. pago_em fica null
  -- de proposito: nao e um recebimento deste mes, e regularizacao -- assim
  -- nao infla nenhum KPI que filtre por data de pagamento.
  update public.parcelas p
  set status='PAGO', atualizado_em=now()
  from public.acordos a
  where a.id = p.acordo_id
    and a.aluno_id = p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');
  get diagnostics v_parcelas = row_count;

  -- Quita os acordos ATIVOS. O trigger trg_titulos_por_status_acordo poe os
  -- titulos vinculados em PAGO automaticamente ao ver o acordo QUITADO.
  update public.acordos
  set status='QUITADO', saldo=0,
      motivo_ajuste=coalesce(motivo_ajuste,'')||' | Quitado e encerrado direto da fila por '||v_email,
      atualizado_em=now()
  where aluno_id = p_aluno_id and upper(coalesce(status,'')) = 'ATIVO';
  get diagnostics v_acordos = row_count;

  -- Quitacao total INTENCIONAL dos titulos do proprio aluno: alem da situacao,
  -- zera o saldo e marca status='quitada' (antes so mudava situacao).
  update public.acordos_titulos t
  set situacao='PAGO', status='quitada', saldo_corrigido=0, valor_em_aberto=0, atualizado_em=now()
  where t.aluno_id = p_aluno_id and t.situacao in ('ABERTO','NEGOCIADO');

  update public.solicitacoes_confirmacao_pagamento
  set status='PAGAMENTO_CONFIRMADO', confirmado_por=v_email, confirmado_em=now(), atualizado_em=now()
  where aluno_id = v_aluno_text and status='AGUARDANDO_CONFIRMACAO';

  update public.baixas_pagamento
  set status_baixa='REALIZADA', baixado_por_email=v_email, baixado_por_nome=coalesce(v_nome,v_email), baixado_em=now(), atualizado_em=now()
  where aluno_id = v_aluno_text and coalesce(status_baixa,'') not in ('REALIZADA','DEVOLVIDA');

  update public.links_pagamento
  set status='BAIXA_REALIZADA', baixado_por=v_email, baixado_em=now(), atualizado_em=now()
  where aluno_id = v_aluno_text and coalesce(status,'') not in ('BAIXA_REALIZADA','BAIXA_DEVOLVIDA');

  insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values (v_aluno_text, 'QUITADO_MANUAL', 'Quitado e encerrado direto da fila', 'QUITADO_MANUAL', coalesce(v_nome, v_email), v_email, now());

  return jsonb_build_object('ok', true, 'casos_quitados', v_casos,
                            'acordos_quitados', v_acordos, 'parcelas_quitadas', v_parcelas);
end;
$function$;
