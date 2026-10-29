-- Rollback de 20260927090000: volta a contar CASO como se fosse aluno e a somar
-- o dinheiro por linha (em dobro quando o aluno tem duas fichas).
--
-- ATENCAO: reverter reintroduz o defeito medido no lote 559b20bb -- a previa
-- voltaria a dizer "8 alunos / R$ 21.751,29" onde o certo e "6 alunos, 8 casos
-- / R$ 15.876,10". Os campos total_casos e total_casos_encerrados deixam de
-- existir, e a tela que os le passa a mostrar vazio no lugar deles.
--
-- Nenhum dado e tocado aqui, nem na ida nem na volta.

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$  create temp table _por_aluno on commit drop as
    select aluno_id,
           max(saldo_total)       as saldo_total,
           max(saldo_mensalidade) as saldo_mensalidade,
           max(saldo_acordo)      as saldo_acordo
      from _cg
     group by aluno_id;

  select jsonb_build_object(
    'total_alunos', (select count(*) from _por_aluno),
    -- CASOS: uma linha por ficha. Aluno com duas fichas conta 1 em
    -- total_alunos e 2 aqui. A previa move CASO, entao a tela precisa dos dois.
    'total_casos',  (select count(*) from _cg),
    'total_valor',  (select round(coalesce(sum(saldo_total),0),2) from _por_aluno),
    'total_mensalidade', (select round(coalesce(sum(saldo_mensalidade),0),2) from _por_aluno),
    'total_acordo',      (select round(coalesce(sum(saldo_acordo),0),2) from _por_aluno),
    'sem_operador', jsonb_build_object(
       'alunos', (select count(distinct aluno_id) from _cg where dono_classe = 'SEM_OPERADOR'),
       'valor',  (select round(coalesce(sum(s),0),2) from (
                    select aluno_id, max(saldo_total) s from _cg
                     where dono_classe = 'SEM_OPERADOR' group by aluno_id) z)),
    'na_carteira_geral', jsonb_build_object(
       'alunos', (select count(distinct aluno_id) from _cg where dono_classe = 'CARTEIRA_GERAL'),
       'valor',  (select round(coalesce(sum(s),0),2) from (
                    select aluno_id, max(saldo_total) s from _cg
                     where dono_classe = 'CARTEIRA_GERAL' group by aluno_id) z)),$ancora$,
$novo$  select jsonb_build_object(
    'total_alunos', (select count(*) from _cg),
    'total_valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg),
    'total_mensalidade', (select round(coalesce(sum(saldo_mensalidade),0),2) from _cg),
    'total_acordo',      (select round(coalesce(sum(saldo_acordo),0),2) from _cg),
    'sem_operador', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'SEM_OPERADOR'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'SEM_OPERADOR')),
    'na_carteira_geral', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'CARTEIRA_GERAL'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'CARTEIRA_GERAL')),$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$       'alunos', (select count(distinct aluno_id) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR')),
       'valor',  (select round(coalesce(sum(s),0),2) from (
                    select aluno_id, max(saldo_total) s from _cg
                     where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR') group by aluno_id) z)),$ancora$,
$novo$       'alunos', (select count(*) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR')),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR'))),$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$     (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),$ancora$,
$novo$     jsonb_array_length(v_itens),$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$     (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
     v_conflitos)$ancora$,
$novo$     (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
     v_conflitos)$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$    -- ALUNOS distintos. A previa expande por aluno, entao um aluno com duas
    -- fichas aparece em dois itens: sao 2 casos, 1 aluno.
    'total_alunos', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),
    -- CASOS que serao movidos, e quantos deles estao encerrados. Encerrado nao
    -- aparece na lista da tela (incluir_encerrados e false por padrao), entao a
    -- gestao precisa ver aqui que ele vai junto.
    'total_casos', jsonb_array_length(v_itens),
    'total_casos_encerrados', (select count(*)::int from jsonb_array_elements(v_itens) it
                                where coalesce((it->>'encerrado')::boolean, false)),$ancora$,
$novo$    'total_alunos', jsonb_array_length(v_itens),$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$    'retornos_preservados', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'retorno_data','') is not null),
    'total_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_mensalidade', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_mensalidade')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_acordo_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_acordo')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),$ancora$,
$novo$    'retornos_preservados', (select count(*)::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'retorno_data','') is not null),
    'total_valor', (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_mensalidade', (select coalesce(sum((it->>'saldo_mensalidade')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_acordo_valor', (select coalesce(sum((it->>'saldo_acordo')::numeric),0) from jsonb_array_elements(v_itens) it),$novo$,
  1);
