-- A tela precisa de um botao "Conferir agora", mas invariantes_rodar() nao pode
-- ficar aberta a qualquer usuario logado -- ela le a base inteira. Entao a tela
-- chama esta porta estreita: exige gestao e so entao repassa.
create or replace function public.invariantes_conferir_agora()
returns table (nome text, achados bigint, valor numeric)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'ACESSO_NEGADO: o vigia e da gestao.';
  end if;
  return query select * from public.invariantes_rodar();
end;
$fn$;

revoke all on function public.invariantes_conferir_agora() from public, anon;
grant execute on function public.invariantes_conferir_agora() to authenticated;
revoke execute on function public.invariantes_rodar(text) from authenticated;
