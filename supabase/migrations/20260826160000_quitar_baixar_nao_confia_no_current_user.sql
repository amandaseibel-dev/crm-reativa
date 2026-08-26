-- A porta de quitar/baixar/lançar estava aberta por dentro.
--
-- O FURO. A função decidia assim:
--
--     if current_user in ('postgres','supabase_admin','service_role') -> true
--
-- A intenção era deixar passar rotina de backend, que roda sem usuário logado.
-- Só que `current_user` dentro de uma função SECURITY DEFINER é o DONO da
-- função (postgres), não quem chamou. Ou seja: qualquer RPC SECURITY DEFINER
-- que perguntasse "esta pessoa pode?" recebia SIM, viesse de quem viesse.
--
-- Descoberto em 26/08/2026 escrevendo o teste de permissão da função nova de
-- honorário por parcela: o operador comum passou. Confirmado em seguida no que
-- já estava em produção: `acordo_definir_honorarios` deixava um operador comum
-- mudar o honorário de qualquer acordo, e prime_conferencia_listar/baixar
-- deixavam qualquer operador ver e baixar títulos da conferência. O honorário é
-- o número pelo qual o operador é cobrado -- era ele podendo mexer na própria
-- nota.
--
-- A CORREÇÃO. Quem manda é o JWT. Se existe usuário logado, só a lista de
-- e-mails decide -- não importa de dentro de qual função a pergunta veio.
-- `current_user` só volta a valer quando NÃO há JWT nenhum, que é exatamente o
-- caso da rotina de backend, do cron e do service_role. É o mesmo desenho de
-- app_pode_borderos_importacoes(), que já estava certo.

create or replace function public.crm_usuario_pode_quitar_baixar()
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  email_logado text;
begin
  -- Negação primeiro: o executor de responsável nunca quita nem baixa.
  if current_user = 'reativa_responsavel_executor' then
    return false;
  end if;

  -- Sem JWT = chamada de backend (cron, pg_net, service_role). Só aqui o papel
  -- do banco decide, porque não há pessoa para consultar.
  if auth.jwt() is null then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;

  -- Com JWT, quem decide é a pessoa -- inclusive dentro de SECURITY DEFINER,
  -- que era onde a regra vazava.
  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));
  return email_logado in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
end;
$function$;

comment on function public.crm_usuario_pode_quitar_baixar() is
  'Porta unica de quitar, baixar, lancar acordo e mexer em honorario: Amanda, Fernanda e Amanda ADM. Com JWT presente, so a lista de e-mails decide -- current_user NAO vale, porque dentro de SECURITY DEFINER ele e o dono da funcao (postgres) e liberava qualquer operador. Sem JWT (cron/service_role), volta a valer o papel do banco.';
