-- UMA FICHA ABERTA POR ALUNO -- a trava que faltava.
--
-- Premissa da Amanda (08/09/2026): UM CPF POR ALUNO, SEMPRE. Se o aluno tem
-- dois cursos, isso vira CAMPO na ficha, nunca uma segunda ficha.
--
-- POR QUE A TRAVA DE HOJE NAO SEGURA. Ela existe desde sempre, mas tem dois
-- furos estruturais, e os dois foram medidos em producao em 08/09:
--
--   1) So dispara em `UPDATE OF aluno_id, encerrado_operacional, status_atual`.
--      Um update em `status_financeiro` ou `status_jornada` passa por fora --
--      e ai o gatilho trg_casos_set_encerrado_operacional reabre o caso sem a
--      trava nunca ter sido consultada. A lista de colunas de um `UPDATE OF` e
--      avaliada contra as colunas do comando, nao contra o que outros gatilhos
--      escrevem depois.
--
--   2) Por ordem alfabetica, trg_caso_nao_duplica_aluno roda ANTES de
--      trg_casos_set_encerrado_operacional. Ou seja: a trava le
--      new.encerrado_operacional antes de quem define esse valor. Ela julga um
--      estado que ainda vai mudar.
--
-- Resultado: 4 alunos com duas fichas abertas ao mesmo tempo, R$ 15.202,96
-- contados duas vezes na carteira -- valor confirmado por dois caminhos
-- independentes (soma por ficha menos soma por CPF fecha exatamente nele).
--
-- O CONSERTO TEM DUAS CAMADAS, e as duas sao necessarias:
--
--   A) A trava vira CONSTRAINT TRIGGER AFTER. Roda depois de TODOS os gatilhos
--      BEFORE, entao enxerga o estado final da linha, e em qualquer alteracao,
--      nao numa lista de colunas. E ela que da a mensagem legivel ao operador.
--
--   B) Um INDICE UNICO PARCIAL. Gatilho e regra de aplicacao; indice e fisica.
--      Com ele o banco fica incapaz de guardar duas fichas abertas do mesmo
--      aluno, mesmo por caminho que ninguem previu -- carga direta, correcao
--      manual, script futuro. E a unica garantia que nao depende de alguem
--      ter lembrado de chamar a trava.
--
-- A migration se RECUSA a aplicar enquanto existir duplicidade na base. Nao ha
-- como criar o indice sobre dados que o violam, e falhar com uma mensagem clara
-- e melhor do que falhar com erro cru do Postgres.

-- ---------------------------------------------------------------------------
-- PORTAO: nao aplica sobre base suja.
-- ---------------------------------------------------------------------------
do $$
declare
  v_alunos integer;
  v_lista  text;
begin
  select count(*), string_agg(aluno_id::text, ', ')
    into v_alunos, v_lista
    from (select aluno_id
            from public.casos
           where aluno_id is not null
             and not coalesce(encerrado_operacional, false)
           group by aluno_id
          having count(*) > 1) x;

  if v_alunos > 0 then
    raise exception
      'MIGRATION ABORTADA: % aluno(s) ainda tem mais de uma ficha aberta. Resolva as fichas antes de instalar a trava. Alunos: %',
      v_alunos, left(v_lista, 500);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A) Mensagem de erro que o operador vai ler.
-- ---------------------------------------------------------------------------
-- A versao anterior devolvia dois UUIDs. Ninguem no atendimento sabe o que
-- fazer com um UUID. Agora diz o nome do aluno e o numero do caso -- que e o
-- que a pessoa ve na tela e consegue procurar.
create or replace function public._caso_nao_duplica_aluno()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_outro_id     uuid;
  v_outro_codigo integer;
  v_nome         text;
begin
  if new.aluno_id is null then return new; end if;
  if coalesce(new.encerrado_operacional, false) then return new; end if;
  if public.caso_encerrado_operacional(new.cpf, new.status_atual, new.status_acionamento,
                                       new.status_financeiro, new.status_jornada) then
    return new;
  end if;

  select c.id, c.caso_codigo into v_outro_id, v_outro_codigo
    from public.casos c
   where c.aluno_id = new.aluno_id
     and c.id <> new.id
     and not coalesce(c.encerrado_operacional, false)
     and public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada) = false
   limit 1;

  if v_outro_id is not null then
    select coalesce(nullif(btrim(a.nome), ''), '(sem nome)') into v_nome
      from public.alunos a where a.id = new.aluno_id;

    raise exception
      'ALUNO_JA_TEM_CASO_ABERTO: % ja esta na fila no caso %. A ficha do aluno e unica -- um CPF, uma ficha. Abra o caso existente e trabalhe nele; se sao dois cursos, isso e um campo na ficha, nao uma segunda ficha.',
      coalesce(v_nome, new.aluno_id::text),
      coalesce(v_outro_codigo::text, left(v_outro_id::text, 8));
  end if;

  return new;
end;
$function$;

-- O gatilho passa a ser CONSTRAINT TRIGGER AFTER: enxerga o estado FINAL da
-- linha, depois de todos os BEFORE, e em qualquer alteracao -- nao numa lista
-- de colunas que outros gatilhos contornam.
drop trigger if exists trg_caso_nao_duplica_aluno on public.casos;
drop trigger if exists trg_zz_caso_nao_duplica_aluno on public.casos;

create constraint trigger trg_zz_caso_nao_duplica_aluno
  after insert or update on public.casos
  deferrable initially immediate
  for each row
  execute function public._caso_nao_duplica_aluno();

-- ---------------------------------------------------------------------------
-- B) A garantia fisica.
-- ---------------------------------------------------------------------------
-- Gatilho pode ser desabilitado, contornado por session_replication_role ou
-- esquecido numa carga. Indice unico, nao.
create unique index if not exists ux_casos_uma_ficha_aberta_por_aluno
    on public.casos (aluno_id)
 where aluno_id is not null
   and not coalesce(encerrado_operacional, false);

comment on index public.ux_casos_uma_ficha_aberta_por_aluno is
  'UM CPF, UMA FICHA. Impede fisicamente duas fichas abertas para o mesmo aluno. A mensagem legivel vem do gatilho trg_zz_caso_nao_duplica_aluno, que roda antes deste indice ser violado.';

-- ---------------------------------------------------------------------------
-- C) A MENSAGEM PRECISA CHEGAR ANTES DO INDICE.
-- ---------------------------------------------------------------------------
-- Erro pego no teste em producao (09/09): so com o CONSTRAINT TRIGGER AFTER,
-- quem barrava primeiro era o INDICE -- ele e verificado no proprio INSERT,
-- antes de qualquer AFTER. O operador via a mensagem crua do Postgres:
--
--   duplicate key value violates unique constraint "ux_casos_uma_ficha_aberta_por_aluno"
--
-- que e exatamente o que esta trava se propunha a evitar.
--
-- CONSERTO: um gatilho BEFORE com a MESMA funcao, chamado `trg_zz_...` de
-- proposito. Gatilhos disparam em ordem alfabetica, e "trg_zz" vem depois de
-- "trg_casos_set_encerrado_operacional" -- entao ele roda por ULTIMO entre os
-- BEFORE e ja enxerga o encerrado_operacional calculado. Era esse o furo
-- original da trava antiga, que rodava ANTES de quem define esse valor.
--
-- As tres camadas, nesta ordem:
--   1. BEFORE  -> a mensagem legivel, no caminho normal;
--   2. indice  -> a garantia fisica, para o que o gatilho nao ve;
--   3. AFTER   -> rede final, enxerga o estado definitivo da linha.
--
-- Verificado em producao: a tentativa de criar uma segunda ficha devolve
-- "ALUNO_JA_TEM_CASO_ABERTO: Jorge Andre Cunha Leal ja esta na fila no caso
-- 15852", e nao mais o erro de indice.
drop trigger if exists trg_zz_caso_nao_duplica_aluno_before on public.casos;

create trigger trg_zz_caso_nao_duplica_aluno_before
  before insert or update on public.casos
  for each row
  execute function public._caso_nao_duplica_aluno();

comment on index public.ux_casos_uma_ficha_aberta_por_aluno is
  'UM CPF, UMA FICHA. Garantia fisica. A mensagem legivel vem do gatilho BEFORE trg_zz_caso_nao_duplica_aluno_before, que roda por ultimo entre os BEFORE e barra antes deste indice ser consultado. Se esta mensagem aparecer crua para alguem, o gatilho BEFORE foi removido.';
