-- Ordem estavel, para a tela poder paginar.
--
-- Amanda, 27/08/2026: "no relatorio de controle de acordo, precisa trazer o ano
-- de 2026 tambem".
--
-- A CAUSA. O teto de mil linhas da API de novo. A funcao devolve 10.533 linhas
-- (gestao, todos os operadores) e a API corta em 1.000 -- sem erro, respondendo
-- 206, que e sucesso. Como a ordem e por vencimento crescente, o que chegava
-- era o COMECO: parcelas ate 07/12/2025. As 9.344 linhas de 2026 nunca
-- apareciam na tela. Nao era filtro de ano faltando: era a metade do dado
-- sendo descartada em silencio.
--
-- Isto aqui e a metade do banco: acrescentar p.id como ultimo criterio de
-- ordenacao. Sem uma coluna UNICA no fim, linhas com o mesmo vencimento e o
-- mesmo nome trocam de lugar entre uma pagina e outra -- a mesma linha vem
-- duas vezes numa e some da outra, e o bug e silencioso.
--
-- A outra metade e a tela passar a buscar de mil em mil (buscarTudo, em
-- src/utils/paginado.js).
--
-- Nenhuma regra muda: mesmo escopo, mesmos estados, mesmos valores.

create or replace function public.honorarios_a_entrar(p_email text default null)
returns table(
  parcela_id uuid, acordo_id uuid, aluno_id uuid, aluno_nome text,
  operador_email text, numero integer, vencimento date, valor numeric,
  honorario numeric, estado text, acordo_total numeric, is_entrada boolean,
  ultimo_acionamento date, dias_sem_acionamento integer, tabulacao text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
    case when upper(coalesce(p.status,'')) = 'PAGO'
         then round(coalesce(
                (select sum(coalesce(b.honorarios_recebidos,0))
                   from public.baixas_pagamento b
                  where b.parcela_id = p.id and b.status_baixa = 'REALIZADA'),
                coalesce(p.honorarios,0)), 2)
         else round(coalesce(p.honorarios,0), 2)
    end,
    case when upper(coalesce(p.status,'')) = 'PAGO' then 'PAGO'
         when p.vencimento < current_date then 'VENCIDO'
         else 'A_VENCER'
    end,
    round(coalesce(a.valor_total,0), 2),
    coalesce(p.is_entrada, false),
    al.data_ultimo_acionamento::date,
    case when al.data_ultimo_acionamento is null then null
         else (current_date - al.data_ultimo_acionamento::date)::integer end,
    nullif(btrim(coalesce(al.status_acionamento,'')), '')
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  left join public.alunos al on al.id = a.aluno_id
  where a.status = 'ATIVO'
    and coalesce(p.status,'') <> 'CANCELADA'
    and (
      v_alvo is null
      or lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )
  -- p.id no fim: desempate unico, sem o qual a paginacao repete e perde linhas.
  order by p.vencimento, al.nome, p.id;
end;
$function$;
