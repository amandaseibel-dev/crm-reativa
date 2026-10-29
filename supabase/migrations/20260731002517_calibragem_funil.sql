-- ============================================================================
-- CALIBRAGEM — FUNIL DE NEGOCIAÇÕES (item 8)
-- ----------------------------------------------------------------------------
-- calibragem_funil(operador?) — estágios do funil com qtd + valor, do link ao
-- acordo/baixa. Operador vê o próprio; gestão vê todos.
-- Reversível.
-- ============================================================================

begin;

create or replace function public.calibragem_funil(p_operador text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_op text := p_operador; v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_res jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then v_op := v_email; end if;

  with links as (
    select status, count(*) q, coalesce(sum(valor),0) v
    from public.links_pagamento where (v_op is null or operador_email = v_op) group by status
  ),
  termos as (
    select status, count(*) q from public.termos_acordo where (v_op is null or operador_email = v_op) group by status
  ),
  conf as (
    select status, count(*) q from public.solicitacoes_confirmacao_pagamento where (v_op is null or operador_email = v_op) group by status
  ),
  acordos as (
    select status, count(*) q, coalesce(sum(saldo),0) v from public.acordos where (v_op is null or operador_responsavel_email = v_op) group by status
  ),
  estagios as (
    select * from (values
      ('Links',      'link_solicitado',   'Link solicitado',                  (select q from links where status='SOLICITADO_LINK'),        (select v from links where status='SOLICITADO_LINK')),
      ('Links',      'link_pronto',       'Link pronto para envio',           (select q from links where status='LINK_PRONTO_PARA_ENVIO'),  (select v from links where status='LINK_PRONTO_PARA_ENVIO')),
      ('Links',      'link_enviado',      'Link enviado (aguard. pagamento)', (select q from links where status='LINK_ENVIADO_AO_ALUNO'),   (select v from links where status='LINK_ENVIADO_AO_ALUNO')),
      ('Links',      'aguardando_baixa',  'Comprovante / aguardando baixa',   (select q from links where status='AGUARDANDO_BAIXA'),        (select v from links where status='AGUARDANDO_BAIXA')),
      ('Confirmação','pgto_aguardando',   'Pagamento aguardando confirmação', (select q from conf where status='AGUARDANDO_CONFIRMACAO'),   0::numeric),
      ('Confirmação','pgto_confirmado',   'Pagamento confirmado',             (select q from conf where status='PAGAMENTO_CONFIRMADO'),     0::numeric),
      ('Termos',     'termo_enviado',     'Termo enviado (aguard. assinatura)',(select q from termos where status='TERMO_ENVIADO_ADM'),     0::numeric),
      ('Termos',     'termo_liberado',    'Termo liberado',                   coalesce((select q from termos where status='TERMO_RECEBIDO_LIBERADO'),0)+coalesce((select q from termos where status='TERMO_LIBERADO_AUTOMATICO_GOV'),0), 0::numeric),
      ('Acordos',    'acordo_ativo',      'Acordo ativo',                     (select q from acordos where status='ATIVO'),                (select v from acordos where status='ATIVO')),
      ('Acordos',    'acordo_quitado',    'Acordo quitado',                   (select q from acordos where status='QUITADO'),              0::numeric),
      ('Baixas',     'baixa_realizada',   'Baixa realizada',                  coalesce((select q from links where status='BAIXA_REALIZADA'),0), coalesce((select v from links where status='BAIXA_REALIZADA'),0)),
      ('Baixas',     'baixa_devolvida',   'Baixa devolvida',                  coalesce((select q from links where status='BAIXA_DEVOLVIDA'),0), coalesce((select v from links where status='BAIXA_DEVOLVIDA'),0))
    ) as t(grupo, chave, rotulo, qtd, valor)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'grupo', grupo, 'chave', chave, 'rotulo', rotulo,
    'qtd', coalesce(qtd,0), 'valor', round(coalesce(valor,0),2))), '[]'::jsonb)
  into v_res from estagios;

  return jsonb_build_object('operador', v_op, 'estagios', v_res);
end; $$;
revoke all on function public.calibragem_funil(text) from public;
grant execute on function public.calibragem_funil(text) to authenticated;

commit;
