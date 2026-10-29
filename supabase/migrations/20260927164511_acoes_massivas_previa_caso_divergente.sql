-- ---------------------------------------------------------------------------
-- A previa passa a dizer, por responsavel, quantos alunos tem o CASO em outra
-- mao -- porque o recorte e pela FICHA, nao pelo caso.
--
-- O QUE FOI MEDIDO (producao, 27/09/2026)
-- acoes_massivas_universo filtra alunos.responsavel_atual_email (a FICHA). A
-- tela rotulava esse controle como "Responsavel pelo caso". Comparando as duas
-- titularidades nos 13.041 alunos com caso vivo:
--   divergem ................................. 20
--   com casos de donos DIFERENTES entre si ....  0
--   ficha vazia e caso com dono ...............  0
--   ficha com dono e caso SEM dono ............ 20  <- todos aqui
-- Espalhados por 8 operadores: cobranca13 (5), cobranca03 (5), cobranca12 (2),
-- cobranca08 (2), cobranca10 (2), cobranca06 (2), cobranca05 (1), cobranca11 (1).
--
-- Nesses 20, o rotulo errava nas DUAS direcoes: filtrar pela pessoa TRAZIA o
-- aluno (a ficha e dela) mesmo com o caso na fila livre; e filtrar por "sem
-- responsavel" NAO trazia, mesmo o caso estando sem dono.
--
-- A REGRA FICA COMO ESTA, e o rotulo e que muda (no mesmo PR, no front):
-- a ficha e UMA por aluno e e por aluno que a previa e o registro agem;
-- `casos` pode ter mais de uma linha por aluno. Trocar a regra mudaria QUEM
-- recebe mensagem, o que nao foi pedido.
--
-- O QUE MUDA AQUI
-- `por_responsavel` ganha `casos_em_outra_mao`: entre os alunos selecionados
-- daquele responsavel, quantos tem o caso com dono diferente do responsavel da
-- linha (inclui caso sem dono). Assim a divergencia aparece POR LOTE, em vez de
-- depender de alguem lembrar que ela existe.
--
-- Nada dispara e nada de dado muda.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

do $pre$
begin
  if not exists (select 1 from pg_proc
                  where oid = 'public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text,text,integer,boolean)'::regprocedure
                    and prosrc like '%por_responsavel%') then
    raise exception 'acoes_massivas_previa nao tem por_responsavel -- aplique 20260927143351 antes desta.';
  end if;
end
$pre$;

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$               'acordos_de_outro_dono', (select count(*) from public.acordos a
                                          where a.aluno_id = any(r.ids)
                                            and lower(coalesce(a.operador_responsavel_email, ''))
                                                is distinct from nullif(r.resp, 'SEM_RESPONSAVEL'))$ancora$,
$novo$               'acordos_de_outro_dono', (select count(*) from public.acordos a
                                          where a.aluno_id = any(r.ids)
                                            and lower(coalesce(a.operador_responsavel_email, ''))
                                                is distinct from nullif(r.resp, 'SEM_RESPONSAVEL')),
               -- O recorte e pela FICHA. Aqui se ve quantos desses alunos tem o
               -- CASO em outra mao (inclui caso sem dono). Medido em 27/09:
               -- 20 alunos em 13.041, todos com ficha com dono e caso sem dono.
               'casos_em_outra_mao', (select count(distinct c.aluno_id) from public.casos c
                                       where c.aluno_id = any(r.ids)
                                         and not coalesce(c.encerrado_operacional, false)
                                         and lower(nullif(btrim(coalesce(c.operador_email, '')), ''))
                                             is distinct from nullif(r.resp, 'SEM_RESPONSAVEL'))$novo$,
  1);
