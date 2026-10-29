-- A lista tinha um furo: so via o que a trava marcou.
--
-- Amanda, 27/08/2026: "tem como verificar na base as duplicidades?".
--
-- Ao conferir, achei o furo. A funcao lia so acordos.duplicado_de, que a trava
-- comecou a preencher HOJE. Duplicidade anterior a isso ficava invisivel numa
-- tela chamada "acordos duplicados" -- pior que nao ter tela.
--
-- Exemplo real: Caio Matheus Ferreira Lopes tem CINCO acordos ATIVOS iguais
-- (R$ 1.601,95 em 6x, acordos 3274/3277/3278/3280/3298), todos de 11/08. Nao
-- aparecia nenhum deles.
--
-- A funcao passa a montar a lista pela CHAVE, nao pela marca: todo grupo de
-- acordos ATIVOS do mesmo aluno com mesmo valor_total e mesma qtd_parcelas.
-- O mais antigo do grupo e o "que ja existia"; cada um dos outros vira uma
-- linha. Grupo de 5 vira 4 linhas.
--
-- A marca da importacao continua sendo usada -- agora como ORIGEM da linha:
--   'IMPORTACAO'       -> a trava marcou; entrou sabendo que era copia
--   'ANTERIOR A TRAVA' -> ja estava na base antes de existir marca
--
-- Isso tambem cobre um caso que a versao anterior perdia: quando o acordo
-- marcado ja foi cancelado (a rotina de substituicao faz isso sozinha), a
-- duplicidade esta RESOLVIDA e nao deve ocupar a lista. Como agora so entram
-- grupos com mais de um ATIVO, esses somem sozinhos -- foi o que aconteceu com
-- Danielly Dias Silveira e Walentin da Costa Pereira.
--
-- Estado em 27/08/2026 depois da importacao da manha: 6 grupos, 9 acordos
-- excedentes, R$ 57.133,26.
--
-- Continua SO GESTAO e somente leitura.
-- Precisa de DROP porque o retorno ganhou duas colunas.

drop function if exists public.acordos_duplicados_sinalizados(text);

create function public.acordos_duplicados_sinalizados(p_email text default null)
returns table(
  acordo_id uuid, numero_acordo bigint, aluno_id uuid, aluno_nome text, cpf text,
  valor_total numeric, qtd_parcelas integer, criado_em timestamptz, observacao text,
  operador_email text,
  existente_id uuid, existente_numero bigint, existente_criado_em timestamptz,
  existente_status text, existente_observacao text,
  parcelas_novo integer, parcelas_pagas_novo integer,
  parcelas_existente integer, parcelas_pagas_existente integer,
  origem text, no_grupo integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_alvo text := nullif(lower(coalesce(p_email,'')), '');
begin
  if coalesce(auth.role(),'') <> 'service_role' and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: requer gestão.' using errcode = '42501';
  end if;

  return query
  with grupos as (
    select a.*,
           count(*)      over w as n_grupo,
           row_number()  over (partition by a.aluno_id, coalesce(a.valor_total,0), coalesce(a.qtd_parcelas,0)
                               order by a.criado_em, a.id) as ordem,
           first_value(a.id) over (partition by a.aluno_id, coalesce(a.valor_total,0), coalesce(a.qtd_parcelas,0)
                                   order by a.criado_em, a.id) as id_primeiro
    from public.acordos a
    where a.status = 'ATIVO' and a.aluno_id is not null
    window w as (partition by a.aluno_id, coalesce(a.valor_total,0), coalesce(a.qtd_parcelas,0))
  )
  select
    n.id, n.numero_acordo, n.aluno_id, coalesce(al.nome,'-'), coalesce(n.cpf, al.cpf),
    round(coalesce(n.valor_total,0),2), n.qtd_parcelas, n.criado_em, n.observacao,
    lower(coalesce(nullif(n.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    v.id, v.numero_acordo, v.criado_em, v.status, v.observacao,
    (select count(*)::int from public.parcelas p where p.acordo_id = n.id),
    (select count(*)::int from public.parcelas p where p.acordo_id = n.id and upper(coalesce(p.status,'')) = 'PAGO'),
    (select count(*)::int from public.parcelas p where p.acordo_id = v.id),
    (select count(*)::int from public.parcelas p where p.acordo_id = v.id and upper(coalesce(p.status,'')) = 'PAGO'),
    case when n.duplicado_de is not null then 'IMPORTACAO' else 'ANTERIOR A TRAVA' end,
    n.n_grupo::int
  from grupos n
  join public.acordos v on v.id = n.id_primeiro
  left join public.alunos al on al.id = n.aluno_id
  where n.n_grupo > 1
    and n.ordem > 1
    and (
      v_alvo is null
      or lower(coalesce(nullif(n.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )
  order by n.valor_total desc, al.nome, n.criado_em;
end;
$function$;

comment on function public.acordos_duplicados_sinalizados(text) is
  'Duplicidades de acordo VIVAS: grupos de acordos ATIVOS do mesmo aluno com mesmo valor_total e mesma qtd_parcelas. O mais antigo do grupo e a referencia; cada um dos outros vira uma linha, com as parcelas pagas dos dois lado a lado. origem diz se a trava da importacao marcou (IMPORTACAO) ou se ja estava na base antes (ANTERIOR A TRAVA). Grupo que sobrou com um so ATIVO some sozinho -- a duplicidade foi resolvida. SO GESTAO, somente leitura: cancelar acordo devolve divida e a Prime nao reverte.';

revoke all on function public.acordos_duplicados_sinalizados(text) from public;
grant execute on function public.acordos_duplicados_sinalizados(text) to authenticated;
