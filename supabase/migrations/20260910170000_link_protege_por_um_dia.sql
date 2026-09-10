-- Link de pagamento passa a proteger o caso por UM DIA, nao para sempre.
--
-- Estava assim: qualquer link com status aberto segurava o caso indefinidamente.
-- Havia 215 links "enviado ao aluno" com media de 32 dias -- casos parados na
-- mao de um operador por um link que o aluno ja tinha ignorado.
--
-- Agora so protege se o envio (ou, quando essa data nao foi gravada, a criacao)
-- foi ontem ou hoje. O fallback para criado_em nao e capricho: 101 dos 215 nao
-- tinham data de envio e perderiam a protecao por falha de registro em vez de
-- por antiguidade, e os 35 "pronto para envio" ainda seriam enviados no dia.
--
-- AGUARDANDO_BAIXA continua protegendo sempre, sem prazo: ali o aluno JA pagou
-- e o dinheiro esta em transito. Mover o caso no meio disso quebraria a baixa.
create or replace function public.caso_protegido_redistribuicao(
  p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean,
  p_status_financeiro text default null::text, p_valor_pago numeric default null::numeric,
  p_quitado_em date default null::date, p_valor_quitado numeric default null::numeric)
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
begin
  if coalesce(p_nao_acionar, false) then return true; end if;

  if v_status_norm = any(bloq) or v_status_fin_norm = any(bloq) then
    return true;
  end if;

  if v_cpf = '00000000000' or v_cpf = '' then
    null;
  elsif exists (select 1 from public.acordos a where a.cpf = v_cpf and a.status = 'ATIVO')
     or exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = v_cpf and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- pagamento em transito: protege sempre
     or exists (select 1 from public.links_pagamento l where l.aluno_cpf = v_cpf and l.status = 'AGUARDANDO_BAIXA')
     -- link vivo: protege por um dia
     or exists (select 1 from public.links_pagamento l
                 where l.aluno_cpf = v_cpf
                   and l.status in ('LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO')
                   and coalesce(l.enviado_ao_aluno_em, l.enviado_em, l.criado_em)::date >= current_date - 1)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_cpf = v_cpf and s.status = 'AGUARDANDO_CONFIRMACAO')
  then
    return true;
  end if;

  if (v_status_norm = any(quit) or v_status_fin_norm = any(quit)
      or coalesce(p_valor_pago,0) > 0 or p_quitado_em is not null or coalesce(p_valor_quitado,0) > 0)
     and public.saldo_titulos_aberto(v_cpf) = 0
  then
    return true;
  end if;

  if v_status_norm in (
    'ACORDO FECHADO','ACORDO EM ANDAMENTO','EM NEGOCIACAO',
    'AGUARDANDO PAGAMENTO','AGUARDANDO FINANCEIRO','EMAIL ENVIADO AO FINANCEIRO','E MAIL ENVIADO FINANC',
    'LINK CARTAO ENVIADO','PAGO PARCIAL','VALORES ENVIADOS','PROPOSTA ENVIADA','PROPOSTA DE EXCECAO',
    'TERMO ENVIADO','TERMO RECEBIDO','EM TRATATIVA','RETORNO AGENDADO'
  ) then
    return true;
  end if;

  return false;
end;
$function$;
