-- =============================================================================
-- ULBRA — avisos de respostas coletadas para o OPERADOR RESPONSÁVEL.
-- PENDENTE. NÃO APLICAR sem autorização expressa da gestão.
--
-- Por que existe: ulbra_conversas só é legível pela gestão (RLS). O sino do
-- operador não pode ler o espelho diretamente. Esta função devolve SÓ as
-- pendências dele, no servidor, sem liberar tabela e sem trazer a fila inteira.
--
-- Quem recebe: o responsável comprovado no ReATIVA pelo caso do aluno:
--   - é o ÚNICO operador com caso do aluno (carteira), OU
--   - assumiu o atendimento (ulbra_atendimentos.responsavel_email).
-- Vínculo ativo alta_cpf é exigido para associar a conversa ao aluno.
-- Gestão não recebe linha daqui (acompanha pela Central).
-- Só leitura. Não altera data, não chama a ULBRA.
-- =============================================================================

create or replace function public.ulbra_avisos_operador(p_limite integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(app_email(), ''));
  v_lim   int := least(greatest(coalesce(p_limite, 200), 1), 500);
  v_linhas jsonb;
begin
  if v_email = '' or not app_usuario_ativo() or eh_painel() or usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;

  with dono as (
    select k.aluno_id, count(distinct lower(k.operador_email)) as qtd,
           min(lower(k.operador_email)) as unico
      from public.casos k
     where k.aluno_id is not null and k.operador_email is not null
     group by k.aluno_id
  ), assum as (
    select t.aluno_id, min(lower(t.responsavel_email)) as por
      from public.ulbra_atendimentos t
     where t.responsavel_email is not null and t.dispensado_em is null
       and t.aluno_status = 'vinculado' and t.aluno_id is not null
     group by t.aluno_id
    having count(distinct lower(t.responsavel_email)) = 1
  ), resp as (
    select d.aluno_id,
           case when d.qtd = 1 then d.unico else a.por end as responsavel
      from dono d left join assum a on a.aluno_id = d.aluno_id
     union
    select a.aluno_id, a.por from assum a
     where not exists (select 1 from dono d where d.aluno_id = a.aluno_id)
  ), base as (
    select c.ulbra_conversa_id, c.aluno_id, c.cliente_nome, c.ultima_mensagem_cliente_em,
           exists (select 1 from public.ulbra_leitura_usuario l
                    where l.ulbra_conversa_id = c.ulbra_conversa_id
                      and l.usuario_email = v_email
                      and l.lido_ate >= c.ultima_mensagem_cliente_em) as lida
      from public.ulbra_conversas c
      join resp r on r.aluno_id = c.aluno_id and r.responsavel = v_email
     where c.aluno_status = 'vinculado'
       and c.aluno_id is not null
       and c.ultima_mensagem_quem = 'cliente'
       and c.ultima_mensagem_cliente_em is not null
       -- vínculo ativo alta_cpf, lido do banco agora (não só o status armazenado)
       and exists (select 1 from public.ulbra_vinculos v
                    where v.ulbra_cliente_id = c.ulbra_cliente_id
                      and v.desvinculado_em is null and v.confianca = 'alta_cpf')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ulbra_conversa_id', b.ulbra_conversa_id,
           'aluno_id', b.aluno_id,
           'nome', b.cliente_nome,
           'ultima_mensagem_cliente_em', b.ultima_mensagem_cliente_em,
           'lida', b.lida
         ) order by b.ultima_mensagem_cliente_em asc, b.ulbra_conversa_id), '[]'::jsonb)
    into v_linhas
    from (select * from base order by ultima_mensagem_cliente_em asc, ulbra_conversa_id limit v_lim) b;

  return jsonb_build_object('ok', true, 'avisos', v_linhas);
end;
$$;

revoke all on function public.ulbra_avisos_operador(integer) from public, anon;
grant execute on function public.ulbra_avisos_operador(integer) to authenticated;
