-- "O que tenho para entrar": a previsao de honorario do operador.
--
-- POR QUE NAO EXISTIA. A Projecao le `pagamentos.valor_honorario`, que vem da
-- importacao do Santander -- ou seja, e 100% REALIZADO. Conferido: NENHUMA das
-- 29 funcoes de projecao le `parcelas`. O numero pelo qual o operador e cobrado
-- so aparecia para ele DEPOIS de acontecer; nao havia onde ver o que ainda pode
-- entrar, nem o que se perdeu por quebra.
--
-- A REGRA (Amanda, 26/08/2026): o honorario da parcela a vencer entra quando
-- ela e paga; se nao for paga, o acordo quebra e ele nao entra. Por isso os
-- estados vem separados e NUNCA somados num numero so:
--
--     A_VENCER -> ainda pode entrar
--     PAGO     -> entrou
--     VENCIDO  -> nao entrou; e a quebra, e o operador precisa ver
--
-- QUEM E O DONO. 1.734 dos 2.829 acordos ATIVOS (61%) estao sem
-- `operador_responsavel_email` -- vieram por importacao. Filtrando so por ele, a
-- tela apareceria vazia para a maioria. Entao vale a mesma regra que o CRM ja
-- usa para carteira e KPI: o dono e o operador do acordo e, na falta dele, o
-- RESPONSAVEL ATUAL DO ALUNO -- quem vai cobrar a parcela e receber por ela.
--
-- TRAZ TAMBEM parcela sem honorario informado (honorario = 0). Nao e ruido: e o
-- trabalho pendente. Em 26/08/2026 eram 2.124 parcelas a vencer com honorario
-- em praticamente nenhuma -- esconde-las mostraria uma previsao vazia sem
-- explicar por que.

create or replace function public.honorarios_a_entrar(p_email text default null)
returns table (
  parcela_id     uuid,
  acordo_id      uuid,
  aluno_id       uuid,
  aluno_nome     text,
  operador_email text,
  numero         integer,
  vencimento     date,
  valor          numeric,
  honorario      numeric,
  estado         text,
  acordo_total   numeric,
  is_entrada     boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_gestao boolean := false;
  v_alvo   text;
begin
  begin
    v_gestao := coalesce(public.usuario_e_gestao(), false);
  exception when others then
    v_gestao := false;
  end;

  -- Operador comum ve sempre o proprio, ignorando o que for pedido.
  v_alvo := case
              when v_gestao then nullif(lower(coalesce(p_email,'')), '')
              else nullif(v_email, '')
            end;

  return query
  select
    p.id, a.id, a.aluno_id,
    coalesce(al.nome, '-'),
    lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    p.numero,
    p.vencimento,
    round(coalesce(p.valor,0), 2),
    round(coalesce(p.honorarios,0), 2),
    case
      when p.status = 'PAGO' then 'PAGO'
      when p.vencimento < current_date then 'VENCIDO'
      else 'A_VENCER'
    end,
    round(coalesce(a.valor_total,0), 2),
    coalesce(p.is_entrada, false)
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  left join public.alunos al on al.id = a.aluno_id
  where a.status = 'ATIVO'
    and coalesce(p.status,'') <> 'CANCELADA'
    and (
      v_alvo is null
      or lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )
  order by p.vencimento, al.nome;
end;
$$;

revoke all on function public.honorarios_a_entrar(text) from public, anon;
grant execute on function public.honorarios_a_entrar(text) to authenticated;

comment on function public.honorarios_a_entrar(text) is
  'Parcelas dos acordos ATIVOS com honorario, em A_VENCER / PAGO / VENCIDO. Dono = operador do acordo ou, na falta, responsavel atual do aluno. Operador ve o proprio; gestao ve todos.';
