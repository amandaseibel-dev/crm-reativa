-- Rollback: volta a versão que confia no current_user.
--
-- ATENÇÃO: isto REABRE o furo. Com esta versão, qualquer operador que chamar
-- uma RPC SECURITY DEFINER que consulte esta função passa pela porta -- foi
-- assim que um operador comum conseguiu mudar honorário de acordo e baixar
-- título na conferência da Prime. Só use se algo de backend legítimo tiver
-- parado, e mesmo assim prefira corrigir o chamador.

create or replace function public.crm_usuario_pode_quitar_baixar()
returns boolean
language plpgsql
stable
set search_path to 'public'
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
