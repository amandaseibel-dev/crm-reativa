-- Rollback de 20261023213000_carteira_curso_semestre_corrige_ambiguidade
--
-- NAO FOI EXECUTADO.
--
-- LEIA ANTES DE RODAR: este rollback devolve a funcao ao estado QUEBRADO.
--
-- A correcao que ele desfaz conserta o erro 42702 que fazia
-- `carteira_curso_semestre_do_operador` falhar em TODA chamada. Reverter
-- significa reintroduzir esse erro. O arquivo existe por disciplina de
-- reversibilidade -- toda migration deste projeto tem o seu --, e nao porque
-- rodar este aqui seja uma boa ideia. So faz sentido se a correcao causar um
-- problema MAIOR que a funcao nao funcionar, o que e dificil: a funcao
-- corrigida e somente leitura e, enquanto a #741 nao for mesclada, ninguem a
-- chama.
--
-- Se o objetivo for tirar a funcao do banco, o caminho nao e este: e um
-- `drop function public.carteira_curso_semestre_do_operador(text)`, que exige
-- autorizacao propria e NAO esta neste arquivo de proposito.
--
-- NADA A RESTAURAR DE DADO: nem a correcao nem a migration original escrevem
-- em tabela alguma. So o corpo da funcao muda, e e por isso que nao ha bloco
-- "ESTADO ANTES" aqui -- o estado anterior e o proprio corpo abaixo.
--
-- `curso_cobranca_alvo` NAO e tocada por este rollback.

create or replace function public.carteira_curso_semestre_do_operador(p_email text default null)
returns table (
  aluno_id              uuid,
  curso_2026_1          text,
  curso_2026_2          text,
  titulos_2026_1        integer,
  saldo_2026_1          numeric,
  titulos_2026_2        integer,
  saldo_2026_2          numeric,
  -- Mensalidade que NAO e de 2026/1 nem de 2026/2. Estas duas colunas existem
  -- para a linha FECHAR: sem elas, o saldo de 2024/2025 sairia da RPC sem
  -- aparecer em coluna nenhuma, e somar as colunas nao daria o saldo da ficha.
  saldo_outros_semestres  numeric,
  saldo_sem_serie         numeric,
  acordo_saldo_2026_1   numeric,
  acordo_saldo_2026_2   numeric,
  -- Parcela de acordo atribuivel a um semestre que nao e 2026/1 nem 2026/2:
  -- R$ 348.556,61 medidos na carteira. Atribuida -- so nao a estes dois.
  acordo_outros_semestres numeric,
  -- Parcela que NAO se sabe de que semestre e: acordo sem titulo vinculado,
  -- com 2+ semestres, ou com titulo sem serie no Prime. NUNCA rateada.
  acordo_indeterminado  numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_eu     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_role   text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_alvo   text := lower(btrim(coalesce(p_email, '')));
  v_gestao boolean;
  v_todos  boolean := false;
begin
  -- PORTAO. A carteira e do operador logado; pedir a de outro exige gestao da
  -- fila -- o mesmo portao que ja libera "abrir a fila de um operador" na tela.
  --
  -- `v_eu` usa coalesce para '' de proposito: com token sem e-mail, comparar
  -- com NULL daria NULL (nem true nem false) e a guarda passaria em silencio.
  v_gestao := (v_role = 'service_role') or public.usuario_e_gestao_fila();

  if v_alvo = '' then
    if v_gestao then
      v_todos := true;                -- gestao sem alvo: a carteira inteira
    elsif v_eu = '' then
      raise exception 'Acesso negado.' using errcode = '42501';
    else
      v_alvo := v_eu;                 -- operador: so a propria carteira
    end if;
  elsif v_alvo <> v_eu and not v_gestao then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  return query
  with cart as (
    select a.id, lpad(regexp_replace(coalesce(a.cpf, ''), '[^0-9]', '', 'g'), 11, '0') cpf
      from public.alunos a
     where coalesce(btrim(a.responsavel_atual_email), '') <> ''
       and (v_todos or lower(btrim(a.responsavel_atual_email)) = v_alvo)
  ),
  serie as (
    select regexp_replace(coalesce(boleto, ''), '[^0-9]', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre
     where coalesce(semestre, '') <> ''
     group by 1
  ),
  -- CURSO por janela do semestre. Uma linha por (ficha, semestre, curso).
  contrato as (
    select c.id,
           case when p.valid_from >= date '2026-01-01' and p.valid_from < date '2026-07-01' then '2026/1'
                when p.valid_from >= date '2026-07-01' and p.valid_from < date '2027-01-01' then '2026/2'
           end sem,
           public.curso_cobranca_alvo(p.curso) curso
      from cart c
      join public.prime_contratos p
        on lpad(regexp_replace(coalesce(p.cpf, ''), '[^0-9]', '', 'g'), 11, '0') = c.cpf
  ),
  curso_ag as (
    select id,
           max(curso) filter (where sem = '2026/1') c1,
           max(curso) filter (where sem = '2026/2') c2
      from contrato
     where sem is not null and curso is not null
     group by id
  ),
  -- MENSALIDADE aberta, pela regra de titulo de `aluno_saldo_pendente_detalhe`
  -- (a candidata a canonica da Etapa 0): respeita `valor_cobranca_ajustado` e
  -- exclui o titulo que ja virou acordo vivo -- cobrar os dois e cobrar duas
  -- vezes.
  tit as (
    select c.id, s.semestre,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) v
      from cart c
      join public.acordos_titulos t on t.aluno_id = c.id
      left join serie s on s.b = regexp_replace(coalesce(t.documento, ''), '[^0-9]', '', 'g')
     where upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos ac on ac.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(ac.status, '')) not in ('CANCELADO', 'CANCELADA'))
  ),
  tit_ag as (
    select id,
           count(*) filter (where semestre = '2026/1')              n1,
           coalesce(sum(v) filter (where semestre = '2026/1'), 0)   s1,
           count(*) filter (where semestre = '2026/2')              n2,
           coalesce(sum(v) filter (where semestre = '2026/2'), 0)   s2,
           coalesce(sum(v) filter (where semestre is not null
                                     and semestre not in ('2026/1','2026/2')), 0) s_outros,
           coalesce(sum(v) filter (where semestre is null), 0)      s_nula
      from tit group by id
  ),
  -- ACORDO: semestre do acordo so quando os titulos dele apontam para UM.
  --
  -- O vinculo titulo<->acordo tem DUAS portas, e as duas valem: a direta
  -- (`acordos_titulos.acordo_id`) e a do mutirao (`acordo_titulo_vinculo`).
  -- Seguir so a direta joga para "indeterminado" R$ 74.384,89 de parcela que
  -- TEM semestre conhecido pela segunda porta -- metade dos acordos da base e
  -- ligada so por ela.
  --
  -- As duas portas entram por `union` de listas prontas, NAO por `or` no join:
  -- `join ... on t.acordo_id = ac.id or exists (...)` e exatamente a forma que
  -- derrubou o banco em 24/09 (job 38), por gerar o produto das duas tabelas.
  tit_base as (
    select t.id titulo_id, t.acordo_id, s.semestre
      from public.acordos_titulos t
      left join serie s on s.b = regexp_replace(coalesce(t.documento, ''), '[^0-9]', '', 'g')
     where t.situacao <> 'DUPLICADA' and coalesce(t.tipo_boleto, '') <> 'Acordo'
  ),
  tit_acordo as (
    select titulo_id, acordo_id, semestre from tit_base where acordo_id is not null
    union
    select b.titulo_id, v.acordo_id, b.semestre
      from public.acordo_titulo_vinculo v
      join tit_base b on b.titulo_id = v.titulo_id
     where coalesce(v.ativo, true)
  ),
  acordo_sem as (
    select acordo_id,
           min(semestre)             semestre,
           count(distinct semestre)  n_sem,
           count(*) filter (where semestre is null) sem_serie
      from tit_acordo
     group by 1
  ),
  parc as (
    select ac.aluno_id,
           case when a.n_sem = 1 and a.sem_serie = 0 then a.semestre end sem,
           sum(coalesce(p.valor, 0)) v
      from public.parcelas p
      join public.acordos ac on ac.id = p.acordo_id
      join cart c on c.id = ac.aluno_id
      left join acordo_sem a on a.acordo_id = ac.id
     where upper(coalesce(ac.status, '')) not in ('CANCELADO', 'CANCELADA')
       and public.parcela_viva(p.status)
     group by 1, 2
  ),
  parc_ag as (
    select aluno_id,
           coalesce(sum(v) filter (where sem = '2026/1'), 0) a1,
           coalesce(sum(v) filter (where sem = '2026/2'), 0) a2,
           coalesce(sum(v) filter (where sem is not null
                                     and sem not in ('2026/1','2026/2')), 0) a_outros,
           coalesce(sum(v) filter (where sem is null), 0)    ind
      from parc group by 1
  )
  select c.id,
         g.c1, g.c2,
         coalesce(t.n1, 0)::integer, round(coalesce(t.s1, 0), 2),
         coalesce(t.n2, 0)::integer, round(coalesce(t.s2, 0), 2),
         round(coalesce(t.s_outros, 0), 2), round(coalesce(t.s_nula, 0), 2),
         round(coalesce(p.a1, 0), 2), round(coalesce(p.a2, 0), 2),
         round(coalesce(p.a_outros, 0), 2), round(coalesce(p.ind, 0), 2)
    from cart c
    left join curso_ag g on g.id = c.id
    left join tit_ag   t on t.id = c.id
    left join parc_ag  p on p.aluno_id = c.id;
end;
$function$;
