-- Minha Carteira: filtros de CURSO e SEMESTRE para o operador.
--
-- SOMENTE LEITURA. Nenhuma tabela e criada ou alterada, nenhum gatilho, nenhum
-- cron. A migration cria uma funcao de classificacao (imutavel) e uma RPC de
-- leitura que devolve, por aluno da carteira, o curso de cada semestre e o
-- saldo/quantidade de titulos de 2026/1 e 2026/2.
--
-- NAO ALTERA distribuicao, fidelizacao, criticidade, retornos nem responsaveis.
-- NAO toca Central de Pagamentos, Santander nem Criticidade.
--
-- ---------------------------------------------------------------------------
-- POR QUE AS FONTES SAO ESTAS (medido em PROD em 2026-10-23, so leitura)
-- ---------------------------------------------------------------------------
--
-- CURSO = `prime_contratos.curso`, a fonte oficial do Prime
--   (63.341 linhas, 3 vazias). As alternativas foram medidas e reprovadas:
--
--     - `alunos.curso` NAO e campo de curso, e de MODALIDADE: 7.782 "Cursos de
--       Graduacao Presencial", 3.886 "Online", 1.319 "Hibrido", 731 "Pos".
--       So 14 das 18.435 fichas tem nome de curso ali, digitado a mao.
--     - `casos.curso` esta vazio em 17.920 de 18.424 linhas (97,3%).
--     - `alunos.curso_real` esta vazio em 45,1%.
--
--   O curso e tomado do contrato VIGENTE NA JANELA DO SEMESTRE, nao "o curso
--   do aluno". Sem a janela, 48 fichas da carteira ficam ambiguas (quem trocou
--   de curso tem 2 contratos); com a janela, a ambiguidade medida e ZERO nas
--   duas janelas (856 fichas em 2026/1, 786 em 2026/2).
--
--   `BIOMEDICINA` contem a palavra MEDICINA e e outro curso: por isso o teste
--   e por PREFIXO com a veterinaria na frente, nunca `ilike '%medicina%'`.
--
-- SEMESTRE = `prime_titulo_semestre.semestre`, pela chave do boleto
--   (`acordos_titulos.documento`) -- 412.238 boletos, 1 linha por boleto.
--   A alternativa foi medida e reprovada:
--
--     - `alunos.semestre_divida` erra ou nao serve em 1.334 das 7.630 fichas
--       da carteira (17,5%): 478 tem titulo em 2+ semestres e o campo e unico,
--       414 estao vazios com titulo datado, 402 DISCORDAM do semestre do
--       titulo e 40 apontam semestre sem nenhum titulo com serie.
--
--   Por isso o corte e no TITULO, nao na ficha: 24 fichas da carteira tem
--   mensalidade aberta nos dois semestres ao mesmo tempo, e um campo por ficha
--   nao consegue representar isso.
--
-- O LADO DO ACORDO entra pela mesma disciplina da Etapa 0 da Efetividade:
--   a parcela viva de um acordo e atribuida a um semestre SO quando os titulos
--   daquele acordo apontam para UM semestre unico. Medido na carteira:
--   839 acordos de 2026/1 (R$ 4.855.671,80) e 65 de 2026/2 (R$ 206.585,25)
--   sao atribuiveis; 1.390 acordos (R$ 5.850.714,19) NAO sao -- 1.358 por nao
--   ter titulo vinculado, 28 por cobrir 2+ semestres e 4 por titulo sem serie.
--   O que nao e atribuivel NUNCA e rateado nem chutado: fica de fora do
--   recorte por semestre e aparece so em "Ambos".

-- ---------------------------------------------------------------------------
-- 1) Classificacao do curso -- um lugar so, imutavel, testavel
-- ---------------------------------------------------------------------------
create or replace function public.curso_cobranca_alvo(p_curso text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  -- Os tres cursos que a cobranca filtra hoje. Devolve null para qualquer
  -- outro -- inclusive BIOMEDICINA, que contem a palavra MEDICINA.
  --
  -- A veterinaria vem ANTES de 'MEDICINA%' de proposito: 'MEDICINA
  -- VETERINARIA' casa os dois prefixos e o primeiro teste e que vale.
  -- O espaco duplo de 'MEDICINA VETERINARIA  INT/NOT' (328 linhas em PROD) e
  -- colapsado antes da comparacao, e o sufixo de turno ('INT/NOT') e o ponto
  -- final de 'ODONTOLOGIA.' sao absorvidos pelo prefixo.
  select case
    when upper(btrim(regexp_replace(coalesce(p_curso, ''), '\s+', ' ', 'g'))) like 'MEDICINA VETERIN%'
      then 'Medicina Veterinária'
    when upper(btrim(regexp_replace(coalesce(p_curso, ''), '\s+', ' ', 'g'))) like 'MEDICINA%'
      then 'Medicina'
    when upper(btrim(regexp_replace(coalesce(p_curso, ''), '\s+', ' ', 'g'))) like 'ODONTOLOGIA%'
      then 'Odontologia'
  end;
$function$;

comment on function public.curso_cobranca_alvo(text) is
  'Normaliza o curso do Prime para os 3 cursos filtrados na Minha Carteira. '
  'Prefixo com a veterinaria na frente; BIOMEDICINA NAO e Medicina. '
  'Qualquer outro curso devolve null.';

-- ---------------------------------------------------------------------------
-- 2) A RPC da tela
-- ---------------------------------------------------------------------------
create or replace function public.carteira_curso_semestre_do_operador(p_email text default null)
returns table (
  aluno_id              uuid,
  curso_2026_1          text,
  curso_2026_2          text,
  titulos_2026_1        integer,
  saldo_2026_1          numeric,
  titulos_2026_2        integer,
  saldo_2026_2          numeric,
  acordo_saldo_2026_1   numeric,
  acordo_saldo_2026_2   numeric,
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
           coalesce(sum(v) filter (where semestre = '2026/2'), 0)   s2
      from tit group by id
  ),
  -- ACORDO: semestre do acordo so quando os titulos dele apontam para UM.
  acordo_sem as (
    select ac.id acordo_id,
           min(s.semestre)             semestre,
           count(distinct s.semestre)  n_sem,
           count(*) filter (where s.semestre is null) sem_serie
      from public.acordos ac
      join public.acordos_titulos t on t.acordo_id = ac.id
      left join serie s on s.b = regexp_replace(coalesce(t.documento, ''), '[^0-9]', '', 'g')
     where t.situacao <> 'DUPLICADA' and coalesce(t.tipo_boleto, '') <> 'Acordo'
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
           coalesce(sum(v) filter (where sem is null), 0)    ind
      from parc group by 1
  )
  select c.id,
         g.c1, g.c2,
         coalesce(t.n1, 0)::integer, round(coalesce(t.s1, 0), 2),
         coalesce(t.n2, 0)::integer, round(coalesce(t.s2, 0), 2),
         round(coalesce(p.a1, 0), 2), round(coalesce(p.a2, 0), 2),
         round(coalesce(p.ind, 0), 2)
    from cart c
    left join curso_ag g on g.id = c.id
    left join tit_ag   t on t.id = c.id
    left join parc_ag  p on p.aluno_id = c.id;
end;
$function$;

comment on function public.carteira_curso_semestre_do_operador(text) is
  'Minha Carteira: curso (contrato do Prime vigente na janela do semestre) e '
  'saldo/titulos de 2026/1 e 2026/2 por ficha da carteira do operador. '
  'Somente leitura. Parcela de acordo entra num semestre SO quando os titulos '
  'do acordo apontam para um semestre unico; o resto vai para '
  'acordo_indeterminado e nunca e rateado.';

-- ---------------------------------------------------------------------------
-- 3) Grants -- explicitos, nunca pelo default do schema
-- ---------------------------------------------------------------------------
revoke all on function public.curso_cobranca_alvo(text) from public;
revoke all on function public.carteira_curso_semestre_do_operador(text) from public;

grant execute on function public.curso_cobranca_alvo(text) to authenticated;
grant execute on function public.curso_cobranca_alvo(text) to service_role;
grant execute on function public.carteira_curso_semestre_do_operador(text) to authenticated;
grant execute on function public.carteira_curso_semestre_do_operador(text) to service_role;
