-- Busca de pagamentos do mês por aluno (nome ou CPF) para a Projeção operacional.
--
-- REGRA DE ISOLAMENTO:
--   - Operador comum e Amanda ADM (cobranca07): só encontram os PRÓPRIOS pagamentos.
--   - Gestão financeira (amanda.seibel, cobranca04): encontram de todos os operadores.
--   Nunca expõe pagamento de colega para operador.
--
-- CPF: a tabela pagamentos não guarda CPF; ele é alcançado via alunos (aluno_id),
--   presente em ~metade dos pagamentos. Por isso a busca por CPF é "melhor esforço"
--   e a UI avisa que pode não achar pagamentos sem vínculo. Busca por nome é completa.

create or replace function public.projecao_pesquisar_pagamento_mes(p_mes text, p_termo text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_email   text := lower(auth.email());
  v_gestao  boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_termo   text := btrim(coalesce(p_termo,''));
  v_nome    text := unaccent(lower(v_termo));
  v_dig     text := regexp_replace(v_termo, '\D', '', 'g');
  v_itens   jsonb;
  v_total   int;
begin
  -- exige usuário autenticado e ativo (ou service_role)
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  -- termo mínimo: 3 letras do nome OU 6 dígitos de CPF
  if char_length(v_nome) < 3 and char_length(v_dig) < 6 then
    return jsonb_build_object(
      'mes', p_mes, 'termo', v_termo, 'total', 0, 'itens', '[]'::jsonb,
      'aviso', 'Digite ao menos 3 letras do nome ou 6 digitos do CPF.');
  end if;

  with hits as (
    select p.data_pagamento, p.aluno_nome, p.valor_pago, p.valor_honorario,
           lower(p.operador_email) as operador_email, p.operador_nome,
           (char_length(v_dig) >= 6 and p.aluno_id is not null
              and regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') like v_dig || '%') as match_cpf,
           (char_length(v_nome) >= 3
              and unaccent(lower(coalesce(p.aluno_nome,''))) like '%' || v_nome || '%') as match_nome
    from public.pagamentos p
    left join public.alunos a on a.id = p.aluno_id
    where to_char(p.data_pagamento, 'YYYY-MM') = p_mes
      and (v_gestao or lower(p.operador_email) = v_email)
  ),
  matched as (
    select * from hits where match_cpf or match_nome
  ),
  lim as (
    select * from matched order by data_pagamento desc, aluno_nome limit 200
  )
  select (select count(*) from matched),
         coalesce((select jsonb_agg(jsonb_build_object(
           'data_pagamento', data_pagamento,
           'aluno_nome',     aluno_nome,
           'valor_pago',     valor_pago,
           'valor_honorario',valor_honorario,
           'operador',       case when v_gestao then coalesce(operador_nome, operador_email) else null end,
           'via',            case when match_cpf then 'CPF' else 'nome' end
         )) from lim), '[]'::jsonb)
    into v_total, v_itens;

  return jsonb_build_object(
    'mes', p_mes, 'termo', v_termo, 'total', coalesce(v_total,0),
    'limite', 200, 'itens', v_itens);
end;
$function$;

revoke all on function public.projecao_pesquisar_pagamento_mes(text,text) from public, anon;
grant execute on function public.projecao_pesquisar_pagamento_mes(text,text) to authenticated, service_role;
