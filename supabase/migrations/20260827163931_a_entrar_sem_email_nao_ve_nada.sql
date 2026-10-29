-- Sem e-mail e sem gestao: nao ve nada. Fecha o unico caminho de vazamento.
--
-- Amanda, 27/08/2026, garantindo para a Luana: "os dos colega nao vai
-- aparecer?".
--
-- Nao aparece -- mas a garantia dependia de um detalhe que nao deveria.
--
-- O ESCOPO era:
--     gestao   -> nullif(p_email, '')     -- vazio = todos, de proposito
--     operador -> nullif(v_email, '')     -- o proprio e-mail
--
-- e o filtro final e `v_alvo is null or dono = v_alvo`. Ou seja: v_alvo NULO
-- significa "traz tudo". Para a gestao isso e a intencao. Para quem nao e
-- gestao, v_alvo so fica nulo se o e-mail da sessao vier vazio -- e ai a
-- funcao devolveria a base inteira, incluindo os acordos dos colegas e os sem
-- responsavel.
--
-- Nao acontece com os operadores de hoje: todos entram por e-mail e o JWT traz
-- o claim. Mas a garantia que a Amanda esta dando para a equipe nao pode
-- depender de o login nunca falhar de um jeito especifico. Uma identidade
-- autenticada sem claim de e-mail (integracao, usuario de servico, mudanca de
-- provedor de login) passaria a ver tudo, em silencio.
--
-- Agora: nao e gestao e nao tem e-mail -> devolve VAZIO. Sem excecao, sem
-- barulho: a tela mostra "nada neste filtro", que e a resposta correta para
-- alguem que nao tem carteira.
--
-- O resto nao muda. Gestao continua vendo tudo e podendo filtrar por operador;
-- operador continua preso ao proprio e-mail, com p_email ignorado.

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

  -- Quem nao e gestao e nao tem e-mail nao tem carteira: lista vazia.
  -- Sem isto, v_alvo nulo cairia no ramo "traz tudo" do filtro abaixo.
  if not v_gestao and v_alvo is null then
    return;
  end if;

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
