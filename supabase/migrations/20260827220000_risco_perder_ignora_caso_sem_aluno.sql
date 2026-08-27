-- Caso sem aluno nao entra no card "risco de perder".
--
-- Amanda, 27/08/2026: "diego tem 122 casos com risco de perder, quando ele
-- clica nao aparece nada".
--
-- A CAUSA. 14 dos 122 casos do Diego nao tem aluno_id -- sao orfaos. A funcao
-- devolvia esses casos assim mesmo, com aluno_id NULO. Do outro lado, a tela
-- faz `String(c.aluno_id)`, que em JavaScript transforma null no TEXTO "null",
-- e manda tudo numa consulta `id IN (...)` contra uma coluna uuid.
--
-- O Postgres rejeita a consulta INTEIRA -- "null" nao e uuid -- e o erro era
-- engolido. Resultado: um unico caso orfao apaga a lista toda. O Diego via 122
-- no card e zero na tela.
--
-- Nao era so ele:
--     Rafaella  160 no card,  6 orfaos  -> 154 invisiveis
--     Diego     122 no card, 14 orfaos  -> 108 invisiveis
--     Mauricio   43 no card,  2 orfaos  ->  41 invisiveis
-- Luana, Joao, Olga e Amanda nao tem orfao nenhum -- por isso a lista deles
-- sempre funcionou, e o problema parecia intermitente.
--
-- A CORRECAO AQUI. Caso sem aluno nao pode ser aberto, acionado nem trabalhado:
-- nao e "risco de perder", e cadastro quebrado. Sai do card. O numero passa a
-- ser exatamente o tamanho da lista, que e o que o operador precisa.
--
-- Os orfaos continuam existindo e precisam de conserto proprio -- e assunto do
-- vinculo caso->aluno, nao desta tela. So param de mentir o contador e de
-- quebrar a lista.
--
-- A tela tambem foi corrigida no mesmo dia (PainelCarteira): descarta id que
-- nao e uuid e nao engole mais o erro da consulta. Duas defesas, porque uma so
-- ja falhou.
--
-- Depois de aplicar: Rafaella 154, Diego 107, Mauricio 41 -- zero orfaos, e o
-- card passa a bater com a lista.

create or replace function public.casos_risco_perder(p_email text default null)
returns table(caso_id uuid, aluno_id uuid, operador_email text, data_ultimo_acionamento date, dias_parado integer, nunca_acionado boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_jwt text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_alvo text := nullif(lower(coalesce(p_email,'')),'');
begin
  -- Operador so enxerga a propria carteira; gestao/diretoria enxerga todas.
  if v_jwt <> '' and not (public.usuario_e_gestao() or public.usuario_tem_visao_geral()) then
    v_alvo := v_jwt;
  end if;

  return query
  select c.id, c.aluno_id, c.operador_email, c.data_ultimo_acionamento,
         case when c.data_ultimo_acionamento is null then null
              else (current_date - c.data_ultimo_acionamento)::int end,
         (c.data_ultimo_acionamento is null)
  from public.casos c
  where c.operador_email is not null
    -- Sem aluno nao ha o que acionar: o caso nao entra no card nem na lista.
    and c.aluno_id is not null
    and (v_alvo is null or lower(c.operador_email) = v_alvo)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
  order by (c.data_ultimo_acionamento is null) desc, c.data_ultimo_acionamento asc nulls first;
end;
$function$;
