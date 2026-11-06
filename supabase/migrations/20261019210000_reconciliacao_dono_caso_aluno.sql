-- RECONCILIACAO DONO/ACIONAMENTO ENTRE FICHA E CASO -- diagnostico ativo,
-- correcao de nascimento INSTALADA DESLIGADA.
--
-- ===================== A CAUSA RAIZ, MEDIDA =====================
--
-- O dono de um aluno mora em DOIS lugares e cada ferramenta le um deles:
--   * public.alunos.responsavel_atual_email -> e o que a FILA OPERACIONAL le
--     (src/pages/FilaOperacional.jsx, filtro MINHA_FILA);
--   * public.casos.operador_email           -> e o que a CARTEIRA GERAL le
--     (carteira_geral_base.dono_email) e de onde SEIS rotinas de distribuicao
--     pescam quando esta NULL (assumir_caso_livre, assumir_caso_livre_aluno,
--     reposicao_carteira_processar, nivelar_medias_progressivo,
--     reforcar_teto_operadores, nivelamento_automatico_gestao).
--
-- Os dois so sao alinhados por UM gatilho de MUDANCA -- _sync_casos_resp_aluno,
-- que exige `new.responsavel_atual_email is distinct from old...`. O mesmo vale
-- para a data: fn_sync_acionamento_alunos_para_casos exige
-- `new.data_ultimo_acionamento is distinct from old`. Conclusao:
-- **nada preenche esses dois campos no NASCIMENTO do caso.** Um caso que nasce
-- NULL fica NULL ate que a ficha mude de dono -- o que pode nunca acontecer.
--
-- Medido em producao em 19/10/2026 (somente leitura):
--   * 15 casos VIVOS com operador_email NULL enquanto a ficha TEM responsavel,
--     R$ 89.419,09 -- 14 criados pelo script avulso de 11/09
--     (`sistema_caso_faltando`, INCIDENTE-513-FICHAS) e 1 por
--     `gestao_excecao_conciliacao`. Perfil do responsavel: 11 operador ativo,
--     4 operador inativo, ZERO gerencia/ADM/supervisao;
--   * 1 caso vivo com data_ultimo_acionamento NULL enquanto a ficha tem data,
--     com saldo (R$ 4.291,04);
--   * 8 alunos com saldo cuja ficha e de operador DESLIGADO (R$ 104.965,66),
--     todos de cobranca03. Destes, os 4 VIVOS tem o caso em NULL -- isto e, a
--     ficha diz "Olga" e o caso esta na FILA LIVRE ao mesmo tempo. Sao
--     invisiveis no painel da Carteira Geral filtrando por responsavel, porque
--     o painel le o CASO (aparecem como SEM_OPERADOR);
--   * `public.recuperar_valor_automatico` -- funcao VIVA, fora de cron -- faz
--     `insert into public.casos (... operador_email ...) values (... NULL ...)`
--     sem data_ultimo_acionamento: ja criou 420 casos nesse formato. E a porta
--     pela qual o problema volta a nascer.
--
-- ===================== O QUE ESTA MIGRATION FAZ =====================
--
-- Cria QUATRO objetos novos. Nao altera, nao substitui e nao reconcede nada do
-- que ja existe -- em particular NAO toca _sync_casos_resp_aluno,
-- fn_sync_acionamento_alunos_para_casos, _aluno_segue_dono_do_acordo,
-- recuperar_valor_automatico nem qualquer funcao carteira_geral_*.
--
--   1. public.cpf_digito_valido(text)            -- helper IMMUTABLE
--   2. public.reconciliacao_dono_caso_aluno(jsonb) -- diagnostico, ATIVO
--   3. public.fichas_duplicadas_revisao(int)     -- fila de revisao humana, ATIVO
--   4. trg_caso_herda_do_aluno (BEFORE INSERT on casos) -- CRIADO DESABILITADO
--
-- ===================== POR QUE O GATILHO NASCE DESLIGADO =====================
--
-- Preencher o dono de um caso no nascimento MUDA DISTRIBUICAO: um caso que
-- antes nascia na fila livre passa a nascer com dono, e deixa de ser pescavel
-- pelas seis rotinas acima. Preencher a data MUDA FIDELIZACAO: um caso que
-- nasce com data fica protegido por caso_dentro_prazo_fidelizacao por ate 10
-- dias, quando antes nascia sem protecao (a funcao devolve false para NULL).
--
-- Mudar regra de distribuicao nao foi autorizado nesta etapa. Entao o gatilho e
-- criado e fica DESABILITADO: `alter table ... disable trigger` no fim desta
-- migration. **Aplicar esta migration nao muda comportamento nenhum.** Ligar e
-- UMA instrucao, em migration separada e com autorizacao propria:
--
--   alter table public.casos enable trigger trg_caso_herda_do_aluno;
--
-- O teste supabase/tests/reconciliacao_dono_caso_aluno.test.js habilita o
-- gatilho dentro de uma transacao, prova o comportamento e desfaz -- e tambem
-- prova que, DESABILITADO, o caso continua nascendo exatamente como hoje.
--
-- ===================== SEM EFEITO FINANCEIRO =====================
--
-- Os objetos 1-3 sao STABLE/IMMUTABLE: o PostgreSQL recusa DML em funcao nao
-- volatil (0A000). O objeto 4 esta desabilitado e, quando ligado, escreve
-- somente em campos do proprio NEW (operador_email, operador_nome, operador,
-- data_ultimo_acionamento) de um caso que esta NASCENDO. Nenhum pagamento,
-- baixa, acordo, parcela, titulo, saldo, status_jornada, status_atual ou
-- data_retorno e lido para escrita ou alterado em lugar nenhum.
--
-- NAO cria retorno artificial: data_retorno nao aparece do lado esquerdo de
-- nenhuma atribuicao. Acao massiva NAO e tratada como contato humano: o campo
-- herdado e o proprio alunos.data_ultimo_acionamento, que e o unico valor que
-- todo o sistema ja chama de "ultimo acionamento" -- esta migration nao cria
-- semantica nova nem reclassifica movimentacao alguma.
--
-- ===================== ROLLBACK (PITR NAO esta habilitado) =====================
--
-- Ver supabase/rollbacks/20261019210000_reconciliacao_dono_caso_aluno.rollback.sql
-- Resumo: drop dos 4 objetos. Nada preexistente e modificado aqui, entao nao ha
-- corpo anterior a restaurar.
begin;

-- --------------------------------------------------------------- 1. CPF helper
-- Digito verificador de CPF. Serve para separar ficha duplicada com CPF
-- CORROMPIDO (artefato de planilha: perde o ultimo digito e ganha um zero a
-- esquerda) de homonimo legitimo. Independente de qualquer fonte externa.
create or replace function public.cpf_digito_valido(p_cpf text)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$
  with d as (select regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g') as v)
  select case
    when (select length(v) from d) <> 11 then false
    -- 00000000000, 11111111111 ... passam na conta e nao sao CPF
    when (select v from d) ~ '^(.)\1{10}$' then false
    else (
      (select ((sum((substr(v, i, 1))::int * (11 - i)) * 10) % 11) % 10
         from d, generate_series(1, 9) i)
        = (select (substr(v, 10, 1))::int from d)
      and
      (select ((sum((substr(v, i, 1))::int * (12 - i)) * 10) % 11) % 10
         from d, generate_series(1, 10) i)
        = (select (substr(v, 11, 1))::int from d)
    )
  end;
$function$;

comment on function public.cpf_digito_valido(text) is
  'Digito verificador de CPF (modulo 11). IMMUTABLE, sem acesso a tabela. Usada por reconciliacao_dono_caso_aluno e fichas_duplicadas_revisao para distinguir CPF corrompido de homonimo.';

revoke all on function public.cpf_digito_valido(text) from public, anon;
grant execute on function public.cpf_digito_valido(text) to authenticated;
grant execute on function public.cpf_digito_valido(text) to service_role;

-- ------------------------------------------------- 2. diagnostico reconciliacao
-- UMA LINHA POR ALUNO, com uma coluna booleana por classe de divergencia. E
-- assim de proposito: somar as classes separadamente conta o mesmo aluno mais
-- de uma vez. Medido em 19/10/2026: as 4 classes somam 38 alunos /
-- R$ 304.749,19, mas a UNIAO real e 32 alunos / R$ 276.946,18 -- 6 alunos e
-- R$ 27.803,01 de dupla contagem. `classes` traz o rotulo de cada um.
create or replace function public.reconciliacao_dono_caso_aluno(p_filtros jsonb default '{}'::jsonb)
 returns table (
   aluno_id uuid,
   caso_id uuid,
   nome text,
   cpf text,
   matricula text,
   saldo_total numeric,
   saldo_vencido numeric,
   dono_ficha text,
   dono_ficha_perfil text,
   dono_ficha_ativo boolean,
   dono_caso text,
   dono_e_bancada boolean,
   dono_inativo boolean,
   caso_sem_operador boolean,
   caso_sem_acionamento boolean,
   ficha_duplicada boolean,
   fidelizacao_vigente boolean,
   encerrado boolean,
   classes text[]
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_apenas_com_saldo boolean := coalesce((p_filtros->>'apenas_com_saldo')::boolean, true);
  v_incluir_encerrados boolean := coalesce((p_filtros->>'incluir_encerrados')::boolean, false);
  v_classe text := nullif(btrim(upper(coalesce(p_filtros->>'classe',''))),'');
begin
  -- V-PORTAO: o retorno nomeia aluno, CPF e saldo. Funcao nova herda EXECUTE
  -- para authenticated pelo default do schema public, entao o portao vai no
  -- CORPO, nao so na concessao.
  if not public.usuario_e_gestao() then
    raise exception 'somente a gestao pode ler a reconciliacao de dono entre ficha e caso'
      using errcode = '42501';
  end if;

  return query
  with dup as (
    -- nome com mais de uma ficha, CPFs diferentes e pelo menos uma com CPF
    -- invalido. Agrupa por nome_normalizado porque o CPF e justamente o campo
    -- em que nao se pode confiar aqui.
    select a.nome_normalizado
      from public.alunos a
     group by a.nome_normalizado
    having count(*) > 1
       and count(distinct regexp_replace(coalesce(a.cpf,''), '[^0-9]', '', 'g')) > 1
       and count(*) filter (where not public.cpf_digito_valido(a.cpf)) > 0
  ),
  base as (
    select
      al.id as aluno_id,
      c.id  as caso_id,
      al.nome,
      al.cpf,
      al.matricula,
      coalesce(al.saldo_total, 0)   as saldo_total,
      coalesce(al.saldo_vencido, 0) as saldo_vencido,
      lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),'')) as dono_ficha,
      u.perfil as dono_ficha_perfil,
      u.ativo  as dono_ficha_ativo,
      lower(nullif(btrim(coalesce(c.operador_email,'')),'')) as dono_caso,
      -- bancada = quem NAO e operador. E a excecao que o gatilho
      -- _aluno_segue_dono_do_acordo ja aplica ("lancamento feito pela bancada
      -- NAO muda o dono") e que a sincronizacao precisa respeitar.
      (u.email is not null and u.perfil <> 'operador') as dono_e_bancada,
      (u.perfil = 'operador' and u.ativo = false)      as dono_inativo,
      (c.id is not null
        and nullif(btrim(coalesce(c.operador_email,'')),'') is null
        and nullif(btrim(coalesce(al.responsavel_atual_email,'')),'') is not null) as caso_sem_operador,
      (c.id is not null
        and c.data_ultimo_acionamento is null
        and al.data_ultimo_acionamento is not null)    as caso_sem_acionamento,
      (d.nome_normalizado is not null)                 as ficha_duplicada,
      coalesce(public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento), false) as fidelizacao_vigente,
      coalesce(c.encerrado_operacional, false)         as encerrado
    from public.alunos al
    left join public.casos c on c.aluno_id = al.id
    left join public.usuarios u on lower(u.email) = lower(al.responsavel_atual_email)
    left join dup d on d.nome_normalizado = al.nome_normalizado
  ),
  marcado as (
    select b.*,
           array_remove(array[
             case when b.dono_inativo         then 'DONO_INATIVO'         end,
             case when b.caso_sem_operador    then 'CASO_SEM_OPERADOR'    end,
             case when b.caso_sem_acionamento then 'CASO_SEM_ACIONAMENTO' end,
             case when b.ficha_duplicada      then 'FICHA_DUPLICADA'      end
           ], null) as classes
      from base b
  )
  select m.aluno_id, m.caso_id, m.nome, m.cpf, m.matricula,
         m.saldo_total, m.saldo_vencido,
         m.dono_ficha, m.dono_ficha_perfil, m.dono_ficha_ativo, m.dono_caso,
         m.dono_e_bancada, m.dono_inativo, m.caso_sem_operador,
         m.caso_sem_acionamento, m.ficha_duplicada,
         m.fidelizacao_vigente, m.encerrado, m.classes
    from marcado m
   where cardinality(m.classes) > 0
     and (not v_apenas_com_saldo or m.saldo_total > 0)
     and (v_incluir_encerrados or not m.encerrado)
     and (v_classe is null or v_classe = any(m.classes))
   order by m.saldo_total desc, m.nome;
end;
$function$;

comment on function public.reconciliacao_dono_caso_aluno(jsonb) is
  'Diagnostico somente-leitura das divergencias de dono/acionamento entre alunos e casos. Uma linha por ALUNO com uma coluna por classe, para que a uniao nao conte o mesmo aluno duas vezes. Portao usuario_e_gestao(). Nao escreve, nao move dono, nao unifica ficha.';

revoke all on function public.reconciliacao_dono_caso_aluno(jsonb) from public, anon;
grant execute on function public.reconciliacao_dono_caso_aluno(jsonb) to authenticated;
grant execute on function public.reconciliacao_dono_caso_aluno(jsonb) to service_role;

-- --------------------------------------------- 3. fila de revisao de duplicadas
-- NAO unifica. Entrega o grupo e a evidencia, uma linha por ficha, para uma
-- pessoa decidir. Unificar cadastro nao foi autorizado e nao esta implementado
-- aqui -- nem como funcao desligada.
create or replace function public.fichas_duplicadas_revisao(p_limite integer default 200)
 returns table (
   grupo text,
   aluno_id uuid,
   nome text,
   cpf text,
   cpf_valido boolean,
   matricula text,
   telefone text,
   email text,
   saldo_total numeric,
   qtd_casos bigint,
   qtd_movimentacoes bigint,
   data_ultimo_acionamento timestamptz,
   mesma_matricula_no_grupo boolean,
   mesmo_telefone_no_grupo boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.usuario_e_gestao() then
    raise exception 'somente a gestao pode ler a fila de fichas duplicadas'
      using errcode = '42501';
  end if;

  return query
  with grupos as (
    select a.nome_normalizado,
           count(distinct nullif(btrim(coalesce(a.matricula,'')),'')) as matriculas,
           count(distinct nullif(btrim(coalesce(a.telefone,'')),'')) as telefones
      from public.alunos a
     group by a.nome_normalizado
    having count(*) > 1
       and count(distinct regexp_replace(coalesce(a.cpf,''), '[^0-9]', '', 'g')) > 1
       and count(*) filter (where not public.cpf_digito_valido(a.cpf)) > 0
  )
  select g.nome_normalizado as grupo,
         a.id as aluno_id,
         a.nome,
         a.cpf,
         public.cpf_digito_valido(a.cpf) as cpf_valido,
         a.matricula,
         a.telefone,
         a.email,
         coalesce(a.saldo_total, 0) as saldo_total,
         (select count(*) from public.casos c where c.aluno_id = a.id) as qtd_casos,
         (select count(*) from public.aluno_movimentacoes m where m.aluno_id = a.id::text) as qtd_movimentacoes,
         a.data_ultimo_acionamento,
         (g.matriculas = 1) as mesma_matricula_no_grupo,
         (g.telefones = 1) as mesmo_telefone_no_grupo
    from grupos g
    join public.alunos a on a.nome_normalizado = g.nome_normalizado
   order by g.nome_normalizado, coalesce(a.saldo_total, 0) desc
   limit greatest(coalesce(p_limite, 200), 1);
end;
$function$;

comment on function public.fichas_duplicadas_revisao(integer) is
  'Candidatos a ficha duplicada: mesmo nome normalizado, CPFs divergentes e pelo menos um CPF reprovado no digito verificador. Uma linha por ficha, com matricula, telefone, saldo e contagem de historico, para REVISAO HUMANA. Nao unifica, nao apaga, nao move nada.';

revoke all on function public.fichas_duplicadas_revisao(integer) from public, anon;
grant execute on function public.fichas_duplicadas_revisao(integer) to authenticated;
grant execute on function public.fichas_duplicadas_revisao(integer) to service_role;

-- ------------------------------------- 4. heranca no nascimento (DESABILITADA)
-- Fecha a porta pela qual o problema nasce, em UM lugar em vez de em cada
-- caminho que cria caso (hoje: recuperar_valor_automatico, o front em
-- CasosSemValor.jsx e scripts avulsos de incidente).
--
-- REGRAS, nesta ordem:
--   a. nunca sobrescreve valor que o INSERT trouxe explicitamente -- so
--      preenche o que vem NULL;
--   b. data_ultimo_acionamento: herda SEMPRE que vier NULL. E uma data, nao uma
--      atribuicao de trabalho, e e o mesmo valor que
--      fn_sync_acionamento_alunos_para_casos gravaria na proxima mudanca da
--      ficha -- com o mesmo cast de fuso (America/Sao_Paulo), porque o campo do
--      caso e `date` e o da ficha e `timestamptz`;
--   c. operador_email: herda SO quando o responsavel da ficha e perfil
--      'operador'. Para BANCADA (gerencia / administrativo / supervisor) o caso
--      fica como veio, e a reconciliacao do objeto 2 o lista com
--      dono_e_bancada = true para decisao humana. E a mesma excecao que
--      _aluno_segue_dono_do_acordo ja aplica em producao;
--   d. herda o operador INATIVO tambem. Trocar dono de aluno desligado nao e
--      trabalho deste gatilho -- e do carteira_geral_mover, com previa e
--      autorizacao. Herdar aqui pelo menos impede que a ficha diga "Olga" e o
--      caso fique na FILA LIVRE ao mesmo tempo, que e o estado dos 4 vivos
--      medidos;
--   e. nunca levanta excecao: criar caso nao pode falhar por causa do
--      alinhamento. Mesma forma defensiva de fn_atualizar_ultimo_acionamento.
create or replace function public._caso_herda_do_aluno()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_dua timestamptz;
  v_resp text;
  v_resp_nome text;
  v_perfil text;
begin
  if new.aluno_id is null then
    return new;
  end if;

  begin
    select a.data_ultimo_acionamento,
           lower(nullif(btrim(coalesce(a.responsavel_atual_email,'')),'')),
           a.responsavel_atual_nome
      into v_dua, v_resp, v_resp_nome
      from public.alunos a
     where a.id = new.aluno_id;

    if new.data_ultimo_acionamento is null and v_dua is not null then
      new.data_ultimo_acionamento := (v_dua at time zone 'America/Sao_Paulo')::date;
    end if;

    if nullif(btrim(coalesce(new.operador_email,'')),'') is null and v_resp is not null then
      select u.perfil into v_perfil from public.usuarios u where lower(u.email) = v_resp;
      -- (c) excecao da bancada: nao herda dono que nao seja operador
      if coalesce(v_perfil, '') = 'operador' then
        new.operador_email := v_resp;
        new.operador_nome  := coalesce(new.operador_nome, v_resp_nome);
        new.operador       := coalesce(new.operador, v_resp_nome);
      end if;
    end if;
  exception when others then
    return new;
  end;

  return new;
end;
$function$;

comment on function public._caso_herda_do_aluno() is
  'BEFORE INSERT em casos: preenche data_ultimo_acionamento e operador_email a partir da ficha quando vierem NULL. Nao sobrescreve valor explicito, nao herda dono de bancada, nao toca data_retorno/status/saldo. Criada DESABILITADA em 20261019210000.';

drop trigger if exists trg_caso_herda_do_aluno on public.casos;
create trigger trg_caso_herda_do_aluno
  before insert on public.casos
  for each row execute function public._caso_herda_do_aluno();

-- A LINHA QUE TORNA ESTA MIGRATION INERTE. Ligar e decisao separada:
--   alter table public.casos enable trigger trg_caso_herda_do_aluno;
alter table public.casos disable trigger trg_caso_herda_do_aluno;

commit;
