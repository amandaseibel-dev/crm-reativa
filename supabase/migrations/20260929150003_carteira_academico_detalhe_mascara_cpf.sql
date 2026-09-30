-- CORREÇÃO 3: o detalhamento mandava CPF INTEIRO num campo chamado "mascarado"
-- ============================================================================
--
-- `carteira_academico_detalhe` devolvia `alunos.cpf_mascarado` tal e qual, e a
-- tela renderiza esse campo direto. Só que a coluna NÃO mascara: medido em
-- produção em 29/09/2026, 15.841 de 15.841 registros com valor trazem o CPF
-- completo. O nome da coluna mente, e quem lê o código acredita nele.
--
-- Na prática, abrir um grupo no detalhamento mandaria o CPF inteiro de até
-- 2.000 alunos ao navegador. O acesso é de gestão (mesmo portão
-- `carteira_2026_1_pode_ler`), então não é vazamento para operador -- mas a
-- função irmã `carteira_2026_2_competencia_detalhe` mascara mesmo para a
-- gestão, e não há razão para esta ser a exceção.
--
-- A máscara é IDÊNTICA à da irmã: 083.***.531-**. CPF que não tenha 11 dígitos
-- vira '***' em vez de vazar um pedaço.
--
-- O QUE NÃO MUDA: a coluna `alunos.cpf_mascarado` NÃO é alterada -- ela é usada
-- em outras telas e consertá-la é outra frente. Aqui só esta função para de
-- confiar nela.

create or replace function public.carteira_academico_detalhe(
  p_ano text, p_semestre text, p_grupo text, p_limite integer default 500
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'grupo', p_grupo,
    'reconstruido_em', now(),
    'alunos', coalesce(jsonb_agg(x order by x->>'nome'), '[]'::jsonb)
  ) into v_out
  from (
    select jsonb_build_object(
      'aluno_id', u.aluno_id,
      'nome', coalesce(a.nome, a.nome_aluno),
      -- MASCARADO DE VERDADE, aqui. `alunos.cpf_mascarado` NAO mascara: medido
      -- em 29/09/2026, 15.841 de 15.841 registros com valor trazem o CPF
      -- inteiro -- o nome da coluna mente. Ler dali mandaria CPF completo ao
      -- navegador para ate 2.000 alunos por grupo. A mascara e a MESMA de
      -- carteira_2026_2_competencia_detalhe, para as duas telas falarem igual.
      'cpf_mascarado', case
        when length(regexp_replace(coalesce(a.cpf,''), '[^0-9]', '', 'g')) = 11
        then substr(regexp_replace(a.cpf, '[^0-9]', '', 'g'),1,3) || '.***.'
          || substr(regexp_replace(a.cpf, '[^0-9]', '', 'g'),7,3) || '-**'
        else '***' end,
      -- SITUAÇÕES ENCONTRADAS: todas, na ordem da API, sem escolher uma. Um
      -- vínculo sem situação aparece como tal, não some da lista.
      'situacoes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'curso', v.curso, 'campus', v.campus, 'turno', v.turno,
                 'status', v.status, 'matricula', v.registration) order by v.ordem)
          from public.prime_academico_consulta c
          join public.prime_academico_vinculo v on v.consulta_id = c.id
         where c.id = (select c2.id from public.prime_academico_consulta c2
                        where c2.aluno_id = u.aluno_id
                          and c2.resultado in ('COM_VINCULOS','SEM_RESULTADO')
                        order by c2.consultado_em desc, c2.id desc limit 1)
      ), '[]'::jsonb),
      'fonte', (select c.fonte from public.prime_academico_consulta c
                 where c.aluno_id = u.aluno_id
                 order by c.consultado_em desc, c.id desc limit 1),
      'consultado_em', (select c.consultado_em from public.prime_academico_consulta c
                         where c.aluno_id = u.aluno_id
                         order by c.consultado_em desc, c.id desc limit 1),
      -- de importação, rotulado como tal -- nunca apresentado como Prime
      'situacao_importada', a.situacao_academica,
      'importado_em', a.academico_atualizado_em
    ) x
    from public.carteira_academico_universo(p_ano, p_semestre) u
    join public.alunos a on a.id = u.aluno_id
   where public.carteira_academico_grupo(u.aluno_id) = p_grupo
   limit greatest(1, least(coalesce(p_limite,500), 2000))
  ) s;

  return v_out;
end;
$$;

comment on function public.carteira_academico_detalhe(text,text,text,integer) is
  'Alunos de um grupo, com TODAS as situações encontradas, fonte e data da consulta. `situacao_importada` vem rotulada como importação, nunca como Prime.';

revoke all on function public.carteira_academico_detalhe(text,text,text,integer) from public, anon;
grant execute on function public.carteira_academico_detalhe(text,text,text,integer) to authenticated, service_role;
