-- Rollback: restaura buscar_aluno para o comportamento anterior
-- (3+ dígitos = só CPF por trecho; sem matrícula).

create or replace function public.buscar_aluno(p_termo text)
 returns setof alunos
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_so_numeros text := regexp_replace(coalesce(p_termo,''), '\D', '', 'g');
  v_termo_normalizado text;
begin
  -- Busca por CPF (3+ digitos): pontual, liberada pra qualquer autenticado.
  if length(v_so_numeros) >= 3 then
    return query
    select * from public.alunos a where a.cpf ilike '%' || v_so_numeros || '%' limit 150;
    return;
  end if;

  -- Busca por NOME: liberada pra qualquer autenticado (necessario pro receptivo
  -- localizar aluno de qualquer operador). Anon continua sem acesso (exige login).
  v_termo_normalizado := lower(translate(coalesce(p_termo,''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuuc AAAAAEEEEIIIIOOOOOUUUUC'));

  return query
  select * from public.alunos a
  where a.nome_normalizado ilike '%' || v_termo_normalizado || '%'
  limit 150;
end;
$function$;
