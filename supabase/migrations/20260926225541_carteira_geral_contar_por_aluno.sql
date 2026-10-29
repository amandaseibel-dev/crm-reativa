-- ---------------------------------------------------------------------------
-- Carteira Geral: contar ALUNO onde o texto diz aluno, e somar dinheiro UMA
-- VEZ por aluno.
--
-- POR QUE
-- `carteira_geral_base` devolve UMA LINHA POR CASO. O painel e a previa
-- tratavam essa linha como se fosse um aluno:
--   painel:  'total_alunos', (select count(*) from _cg)
--   previa:  'total_alunos', jsonb_array_length(v_itens)
-- Quando um aluno tem duas fichas (dois casos), ele contava duas vezes.
--
-- Pior que a contagem: o saldo vem da view `calibragem_saldo_aluno`, que e POR
-- ALUNO. As duas linhas do mesmo aluno carregam o MESMO saldo, e somar por
-- linha soma o dinheiro em dobro.
--
-- MEDIDO no lote 559b20bb (26/09/2026 22:10:05 UTC), o unico ja confirmado:
--   itens na previa ............. 8   (8 casos)
--   alunos distintos ............ 6
--   total_alunos que ela gravou . 8   <- errado, eram 6
--   total_valor que ela gravou .. R$ 21.751,29  <- errado
--   valor distinto real ......... R$ 15.876,10
-- A diferenca de R$ 5.875,19 e exatamente o saldo das duas fichas gemeas
-- (Cristovao 2.968,27 + Felipe 2.906,92) contado duas vezes.
--
-- Na carteira que a Olga ainda tem a distorcao e ZERO hoje (495 casos = 495
-- alunos distintos, medido em 27/09). O defeito e real, mas ainda nao mordeu
-- numero grande -- so os dois casos gemeos que ja sairam.
--
-- O QUE MUDA
-- 1. painel: total_alunos e os recortes contam `distinct aluno_id`; dinheiro
--    soma uma vez por aluno.
-- 2. previa: total_alunos conta alunos distintos; dinheiro e retornos somam uma
--    vez por aluno.
-- 3. previa: campos NOVOS, para a tela poder separar as tres coisas:
--       total_casos ............... quantos casos serao movidos
--       total_casos_encerrados .... quantos deles estao encerrados
--    Nenhum campo antigo foi removido: a tela publicada continua lendo o que
--    lia.
--
-- O QUE NAO MUDA
-- Assinatura, tipo de retorno, SECURITY DEFINER, search_path, ACL e a LISTA de
-- itens. Nada de dado e escrito ou movido por esta migration. As previas ja
-- gravadas NAO sao reescritas -- a de 559b20bb segue com o numero antigo, e e
-- por isso que o diagnostico dela esta no comentario acima.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

-- PRECONDICAO: as duas funcoes tem de existir com a assinatura esperada.
do $pre$
begin
  perform 'public.carteira_geral_painel(jsonb)'::regprocedure;
  perform 'public.carteira_geral_previa(uuid[],text,text,boolean,jsonb,uuid[])'::regprocedure;
exception when undefined_function then
  raise exception 'carteira_geral_painel/previa nao existem com a assinatura esperada -- aplique 20260925181117 antes desta.';
end
$pre$;

-- ---------------------------------------------------------------------------
-- 1) PAINEL: contar aluno distinto e somar dinheiro uma vez por aluno.
--
-- O saldo em `_cg` ja e POR ALUNO (vem da view calibragem_saldo_aluno), entao
-- para um aluno com duas fichas as duas linhas trazem o MESMO valor: `max` nao
-- e escolha arbitraria, e o unico valor que existe.
--
-- As quebras por classe tambem passam a contar aluno distinto, senao o total
-- diria 6 e a soma das partes diria 8. Quando as duas fichas do mesmo aluno tem
-- donos de classes diferentes ele conta em cada classe -- isso e proposital: as
-- partes respondem "quantos alunos tem caso nesta situacao", nao formam
-- particao. `por_responsavel` segue caso a caso, que e o que a tela filtra.
-- ---------------------------------------------------------------------------
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$  select jsonb_build_object(
    'total_alunos', (select count(*) from _cg),
    'total_valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg),
    'total_mensalidade', (select round(coalesce(sum(saldo_mensalidade),0),2) from _cg),
    'total_acordo',      (select round(coalesce(sum(saldo_acordo),0),2) from _cg),
    'sem_operador', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'SEM_OPERADOR'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'SEM_OPERADOR')),
    'na_carteira_geral', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'CARTEIRA_GERAL'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'CARTEIRA_GERAL')),$ancora$,
$novo$  create temp table _por_aluno on commit drop as
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
                     where dono_classe = 'CARTEIRA_GERAL' group by aluno_id) z)),$novo$,
  1);

-- A terceira quebra, no mesmo criterio.
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$       'alunos', (select count(*) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR')),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR'))),$ancora$,
$novo$       'alunos', (select count(distinct aluno_id) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR')),
       'valor',  (select round(coalesce(sum(s),0),2) from (
                    select aluno_id, max(saldo_total) s from _cg
                     where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR') group by aluno_id) z)),$novo$,
  1);

-- ---------------------------------------------------------------------------
-- 2) PREVIA: o que fica GRAVADO na linha da previa.
-- ---------------------------------------------------------------------------
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$    (v_autor, coalesce(p_filtros,'{}'::jsonb), p_destino_tipo, v_destino_email, v_itens,
     jsonb_array_length(v_itens),$ancora$,
$novo$    (v_autor, coalesce(p_filtros,'{}'::jsonb), p_destino_tipo, v_destino_email, v_itens,
     (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),$novo$,
  1);

-- O valor gravado: uma vez por aluno.
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$     (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
     v_conflitos)$ancora$,
$novo$     (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
     v_conflitos)$novo$,
  1);

-- ---------------------------------------------------------------------------
-- 3) PREVIA: o que ela DEVOLVE para a tela.
-- ---------------------------------------------------------------------------
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$    'total_alunos', jsonb_array_length(v_itens),$ancora$,
$novo$    -- ALUNOS distintos. A previa expande por aluno, entao um aluno com duas
    -- fichas aparece em dois itens: sao 2 casos, 1 aluno.
    'total_alunos', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it),
    -- CASOS que serao movidos, e quantos deles estao encerrados. Encerrado nao
    -- aparece na lista da tela (incluir_encerrados e false por padrao), entao a
    -- gestao precisa ver aqui que ele vai junto.
    'total_casos', jsonb_array_length(v_itens),
    'total_casos_encerrados', (select count(*)::int from jsonb_array_elements(v_itens) it
                                where coalesce((it->>'encerrado')::boolean, false)),$novo$,
  1);

-- Retornos e dinheiro devolvidos: uma vez por aluno. O retorno mora na FICHA do
-- aluno, nao no caso: contar por item duplicaria o mesmo agendamento.
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_previa',
$ancora$    'retornos_preservados', (select count(*)::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'retorno_data','') is not null),
    'total_valor', (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_mensalidade', (select coalesce(sum((it->>'saldo_mensalidade')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_acordo_valor', (select coalesce(sum((it->>'saldo_acordo')::numeric),0) from jsonb_array_elements(v_itens) it),$ancora$,
$novo$    'retornos_preservados', (select count(distinct it->>'aluno_id')::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'retorno_data','') is not null),
    'total_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_total')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_mensalidade', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_mensalidade')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),
    'total_acordo_valor', (select coalesce(sum(s),0) from (
        select max((it->>'saldo_acordo')::numeric) as s
          from jsonb_array_elements(v_itens) it group by it->>'aluno_id') z),$novo$,
  1);
