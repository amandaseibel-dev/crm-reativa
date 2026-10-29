-- Trava especifica: quem pode QUITAR e dar BAIXA (nao amplia os demais poderes)
create or replace function public.crm_usuario_pode_quitar_baixar()
 returns boolean
 language plpgsql
 stable
as $function$
declare
  email_logado text;
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return true;
  end if;
  if current_user = 'reativa_responsavel_executor' then
    return false;
  end if;
  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));
  return email_logado in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
end;
$function$;

-- Aprovacao de quitacao: usa a trava nova
create or replace function public.bloquear_aprovacao_quitacao()
 returns trigger
 language plpgsql
as $function$
begin
  if public.crm_usuario_pode_quitar_baixar() then
    return new;
  end if;
  if new.acao_quitacao is distinct from old.acao_quitacao
    or new.aprovado_por is distinct from old.aprovado_por
    or new.aprovado_em is distinct from old.aprovado_em
    or new.rejeitado_por is distinct from old.rejeitado_por
    or new.rejeitado_em is distinct from old.rejeitado_em
    or new.motivo_revisao is distinct from old.motivo_revisao
    or new.caso_registro_unico is distinct from old.caso_registro_unico
  then
    raise exception 'Acao permitida somente para Amanda gestora, Fernanda ou Amanda ADM.';
  end if;
  return new;
end;
$function$;

-- Baixa de pagamento: usa a trava nova
create or replace function public.bloquear_baixa_pagamento()
 returns trigger
 language plpgsql
as $function$
begin
  if public.crm_usuario_pode_quitar_baixar() then
    return new;
  end if;
  if new.status = 'BAIXADO'
    or old.status = 'BAIXADO'
    or new.baixado_por is distinct from old.baixado_por
    or new.baixado_em is distinct from old.baixado_em
  then
    raise exception 'Baixa de pagamento permitida somente para Amanda gestora, Fernanda ou Amanda ADM.';
  end if;
  return new;
end;
$function$;
