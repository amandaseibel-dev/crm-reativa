-- ---------------------------------------------------------------------------
-- "Por responsavel" passa a dizer CASOS e ALUNOS, separados.
--
-- POR QUE
-- A linha da gestora mostrava "Amanda Gestora: 11" sob a coluna **Alunos**, e o
-- 11 vinha de `'alunos', count(*)` sobre `_cg` -- que tem UMA LINHA POR CASO.
-- Era, portanto, uma contagem de CASO rotulada como aluno.
--
-- O estrago nao e so de rotulo: quem le "11" ao lado do proprio nome conclui
-- que responde por 11 coisas, quando responde por 753 ACORDOS (653 ATIVO),
-- medido em 27/09/2026 -- e 726 deles estao em casos de OUTRAS pessoas. Caso e
-- acordo sao titularidades diferentes, e a tela precisa dizer qual e qual.
--
-- O QUE MUDA
-- `por_responsavel` passa a trazer os DOIS numeros:
--   'casos'  = count(*)                 -- uma linha por ficha
--   'alunos' = count(distinct aluno_id) -- pessoas distintas
-- Antes, 'alunos' carregava o valor de 'casos'. Para a carteira da gestora os
-- dois sao 11 (11 casos, 11 alunos distintos); onde houver ficha gemea eles
-- passam a divergir, que e o certo.
--
-- A ordenacao da lista continua por 'alunos' desc -- o campo existe, so mudou
-- de criterio, e a ordem por pessoas distintas e a que faz sentido na leitura.
--
-- O QUE NAO MUDA
-- Assinatura, SECURITY DEFINER, search_path, ACL. Nenhum outro campo. Nada de
-- dado e movido.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$                 'alunos', count(*),$ancora$,
$novo$                 -- CASOS e ALUNOS, separados: `_cg` tem uma linha por caso,
                 -- e chamar isso de "alunos" era o que fazia a gestora ler
                 -- "11" e entender que responde por 11 coisas.
                 'casos', count(*),
                 'alunos', count(distinct aluno_id),$novo$,
  1);
