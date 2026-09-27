-- Rollback de 20260927200000: a previa deixa de contar `casos_em_outra_mao`.
--
-- ATENCAO: reverter esconde de novo a divergencia entre a FICHA (que e o que o
-- filtro recorta) e o CASO -- 20 alunos em 13.041, medido em 27/09/2026. A tela
-- publicada le a chave; sem ela a coluna fica vazia, sem quebrar.
--
-- Nenhum dado e movido aqui.

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$,
               -- O recorte e pela FICHA. Aqui se ve quantos desses alunos tem o
               -- CASO em outra mao (inclui caso sem dono). Medido em 27/09:
               -- 20 alunos em 13.041, todos com ficha com dono e caso sem dono.
               'casos_em_outra_mao', (select count(distinct c.aluno_id) from public.casos c
                                       where c.aluno_id = any(r.ids)
                                         and not coalesce(c.encerrado_operacional, false)
                                         and lower(nullif(btrim(coalesce(c.operador_email, '')), ''))
                                             is distinct from nullif(r.resp, 'SEM_RESPONSAVEL'))$ancora$,
$novo$$novo$,
  1);
