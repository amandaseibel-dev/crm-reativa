-- MEDICAO do bug "dono do acordo" -- 12/09/2026. SOMENTE LEITURA.
--
-- Roda em producao sem alterar nada. Compara, acordo por acordo ATIVO, o dono
-- que as RPCs devolviam ANTES:
--
--   coalesce(al.responsavel_atual_email, a.operador_responsavel_email)
--
-- com o dono DEPOIS da migration 20260912203000:
--
--   lower(nullif(trim(a.operador_responsavel_email), ''))
--
-- Os numeros abaixo sao os medidos em 12/09/2026 e servem de gabarito: rodar de
-- novo depois de aplicar a migration tem de dar o MESMO "depois".
--
-- Nao inclui nada do fluxo Santander/pagamentos.

-- ---------------------------------------------------------------------------
-- A) ANTES x DEPOIS por linha da tela
--    Medido em 12/09/2026 -- total 2.514 acordos ATIVO / R$ 11.783.364,04:
--      Olga          373 -> 261   |  Luana         297 -> 181
--      Nataly        293 -> 157   |  Mauricio      292 -> 123
--      Joao          322 -> 170   |  Rafaella      312 -> 152
--      Allan         288 -> 129   |  Diego         283 -> 120
--      Amanda         18 -> 330   |  Amanda Borges  25 ->  96
--      Fernanda        1 ->  42   |  Painel TV       0 ->   1
--      Sem responsavel 10 -> 752
-- ---------------------------------------------------------------------------
with ac as (
  select a.id, coalesce(a.saldo, 0) as saldo,
         lower(nullif(coalesce(al.responsavel_atual_email, a.operador_responsavel_email), '')) as dono_antes,
         lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono_depois
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status, '')) = 'ATIVO'
),
antes  as (select coalesce(dono_antes,  'sem-responsavel') k, count(*) q, sum(saldo) s from ac group by 1),
depois as (select coalesce(dono_depois, 'sem-responsavel') k, count(*) q, sum(saldo) s from ac group by 1)
select coalesce(u.nome, coalesce(a.k, d.k))                         as linha,
       coalesce(a.q, 0)                                             as acordos_antes,
       round(coalesce(a.s, 0)::numeric, 2)                          as saldo_antes,
       coalesce(d.q, 0)                                             as acordos_depois,
       round(coalesce(d.s, 0)::numeric, 2)                          as saldo_depois,
       coalesce(d.q, 0) - coalesce(a.q, 0)                          as delta_acordos,
       round((coalesce(d.s, 0) - coalesce(a.s, 0))::numeric, 2)      as delta_saldo
  from antes a
  full join depois d on d.k = a.k
  left join public.usuarios u on lower(u.email) = coalesce(a.k, d.k)
 order by coalesce(d.s, 0) desc;

-- ---------------------------------------------------------------------------
-- B) As tres classes de acordo
--    Medido em 12/09/2026:
--      1_INALTERADO            1.199  R$ 7.391.073,11
--      2_MUDA_DE_DONO            573  R$ 3.769.476,89   <- troca de dono
--      3_VIRA_SEM_RESPONSAVEL    742  R$   622.814,04   <- vira "Sem responsavel"
--      4_GANHA_DONO                0  R$         0,00   (impossivel pelo coalesce)
--    1.315 acordos / R$ 4.392.290,93 mal exibidos hoje.
-- ---------------------------------------------------------------------------
with ac as (
  select a.id, coalesce(a.saldo, 0) as saldo,
         lower(nullif(coalesce(al.responsavel_atual_email, a.operador_responsavel_email), '')) as dono_antes,
         lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono_depois
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status, '')) = 'ATIVO'
)
select case
         when dono_antes is not distinct from dono_depois then '1_INALTERADO'
         when dono_antes is not null and dono_depois is not null then '2_MUDA_DE_DONO'
         when dono_antes is not null and dono_depois is null then '3_VIRA_SEM_RESPONSAVEL'
         else '4_GANHA_DONO'
       end as classe,
       count(*) as acordos, round(sum(saldo)::numeric, 2) as saldo
  from ac group by 1
union all
select '0_TOTAL_ATIVO', count(*), round(sum(saldo)::numeric, 2) from ac
 order by 1;

-- ---------------------------------------------------------------------------
-- C) Provas de que os 573 FORAM PARA ALGUEM, e nao desapareceram
--    Medido em 12/09/2026: A3 = 573 de 573, A4 = 573, A5 = 0, A6 = 1.
--
--    SALDO DO ITEM "acordos sem superficie operacional apos a mudanca":
--      0 responsaveis operacionais invalidos  (A5: dono preenchido sem usuario,
--                                              ou usuario inativo)
--    + 1 excecao tecnica conhecida            (A6: acordo 2371,
--                                              painel.tv@reativa.local,
--                                              R$ 236.929,17 -- ver bloco D)
--
--    Dizer so "zero" apagaria a excecao. Ela nao e corrigida e nao e
--    redistribuida: e rotulada na tela de gestao como
--    "Responsavel tecnico / revisar" (flag `responsavel_tecnico` da RPC).
-- ---------------------------------------------------------------------------
with ac as (
  select a.id, coalesce(a.saldo, 0) as saldo,
         lower(nullif(coalesce(al.responsavel_atual_email, a.operador_responsavel_email), '')) as dono_antes,
         lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono_depois
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
   where upper(coalesce(a.status, '')) = 'ATIVO'
),
trocam as (select * from ac where dono_antes is not null and dono_depois is not null and dono_antes <> dono_depois)
select 'A1 total de acordos ATIVO' prova, count(*)::text resultado from ac
union all select 'A2 acordos que trocam de dono', (select count(*)::text from trocam)
union all select 'A3 dos que trocam, com dono_depois cadastrado em usuarios',
  (select count(*)::text from trocam t join public.usuarios u on lower(u.email) = t.dono_depois)
union all select 'A4 dos que trocam, com dono_depois ATIVO',
  (select count(*)::text from trocam t join public.usuarios u on lower(u.email) = t.dono_depois where coalesce(u.ativo, false))
union all select 'A5 responsaveis operacionais INVALIDOS (dono preenchido sem usuario, ou inativo)',
  (select count(*)::text from ac left join public.usuarios u on lower(u.email) = ac.dono_depois
    where ac.dono_depois is not null and (u.email is null or coalesce(u.ativo, false) = false))
union all select 'A6 EXCECOES TECNICAS conhecidas (dono gravado que nao e conta de operacao)',
  (select count(*)::text || ' acordo(s), saldo R$ ' || to_char(coalesce(sum(coalesce(ac.saldo, 0)), 0), 'FM999G999G990D00')
     from ac join public.usuarios u on lower(u.email) = ac.dono_depois
    where coalesce(u.ativo, false) and u.perfil not in ('operador', 'supervisor', 'gerencia', 'administrativo'))
union all select 'A7 soma dos saldos (conservada: a mudanca e de leitura, nao de dado)',
  (select to_char(sum(saldo), 'FM999G999G990D00') from ac);

-- ---------------------------------------------------------------------------
-- D) ANOMALIA / EXCECAO TECNICA -- acordo ATIVO cujo responsavel nao e conta de
--    operacao. NAO CORRIGIR e NAO REDISTRIBUIR. Vira excecao de gestao: a RPC
--    marca a linha com `responsavel_tecnico` e a tela rotula
--    "Responsavel tecnico / revisar".
--    Medido em 12/09/2026: 1 acordo, numero 2371, painel.tv@reativa.local
--    (perfil "painel", ativo), saldo R$ 236.929,17, 6 parcelas VENCIDAS e 0 a
--    vencer (vencimentos de 28/02/2026 a 31/07/2026). A ficha do aluno e da
--    Olga (cobranca03) -- por isso hoje o acordo aparece como se fosse dela.
-- ---------------------------------------------------------------------------
select a.numero_acordo, a.operador_responsavel_email, u.nome, u.perfil, u.ativo,
       round(coalesce(a.saldo, 0)::numeric, 2) as saldo,
       left(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 3) || '.***.***-'
         || right(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 2) as cpf,
       left(al.nome, 1) || '***' as aluno,
       lower(al.responsavel_atual_email) as ficha_de,
       (select count(*) from public.parcelas p where p.acordo_id = a.id and p.status = 'VENCIDA')  as vencidas,
       (select count(*) from public.parcelas p where p.acordo_id = a.id and p.status = 'A_VENCER') as a_vencer
  from public.acordos a
  join public.usuarios u on lower(u.email) = lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), ''))
  left join public.alunos al on al.id = a.aluno_id
 where upper(coalesce(a.status, '')) = 'ATIVO'
   and (coalesce(u.ativo, false) = false
        or u.perfil not in ('operador', 'supervisor', 'gerencia', 'administrativo'))
 order by a.saldo desc;

-- ---------------------------------------------------------------------------
-- E) "CPFs com acordo" na Minha Carteira: antes era "aluno da MINHA ficha que
--    tem acordo (de quem quer que seja)"; depois e "acordo que e MEU".
--    A ultima coluna e o tamanho do problema inverso: acordo meu cuja ficha e
--    de outra pessoa -- hoje nao aparece como acordo de ninguem.
--    Medido em 12/09/2026 (antes -> depois | acordo meu, ficha de outro):
--      Amanda    16 -> 314 | 298    Amanda Borges  22 ->  89 | 67
--      Olga     312 -> 249 |  63    Fernanda        1 ->  41 | 40
--      Luana    256 -> 171 |  46    Nataly        256 -> 154 | 37
--      Joao     286 -> 165 |  25    Rafaella      261 -> 143 | 28
--      Allan    251 -> 122 |  23    Mauricio      254 -> 119 | 26
--      Diego    246 -> 114 |  20
--
--    Usa casos.encerrado_operacional em vez da view canonica
--    calibragem_saldo_aluno porque a view depende de
--    titulo_superado_por_acordo (SECURITY DEFINER), inacessivel ao usuario de
--    leitura. O universo de acordo/parcela e o mesmo da view.
-- ---------------------------------------------------------------------------
with ops as (
  select lower(email) e, nome from public.usuarios
   where coalesce(ativo, false) and perfil in ('operador', 'supervisor', 'gerencia', 'administrativo')
),
ficha as (
  select lower(c.operador_email) e, c.aluno_id,
         coalesce(nullif(lpad(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'), 11, '0'), '00000000000'),
                  c.id::text) chave
    from public.casos c
   where coalesce(c.encerrado_operacional, false) = false and c.aluno_id is not null
),
acordo_vivo as (
  select a.id, a.aluno_id,
         lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) dono,
         coalesce(nullif(lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0'), '00000000000'),
                  al.id::text) chave
    from public.acordos a join public.alunos al on al.id = a.aluno_id
   where lower(coalesce(a.status, '')) not in ('cancelado', 'cancelada')
     and exists (select 1 from public.parcelas p
                  where p.acordo_id = a.id
                    and upper(coalesce(p.status, '')) not in ('PAGO', 'PAGA', 'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO'))
)
select o.nome,
  (select count(distinct f.chave) from ficha f join acordo_vivo av on av.aluno_id = f.aluno_id where f.e = o.e) as cpfs_com_acordo_antes,
  (select count(distinct av.chave) from acordo_vivo av where av.dono = o.e) as cpfs_com_acordo_depois,
  (select count(distinct av.chave) from acordo_vivo av
    where av.dono = o.e and not exists (select 1 from ficha f where f.e = o.e and f.aluno_id = av.aluno_id)) as acordo_meu_ficha_de_outro
  from ops o order by 3 desc;

-- ---------------------------------------------------------------------------
-- F) DIRECAO INVERSA, num caso real: acordo 906 -- ficha da Luana
--    (cobranca05), acordo da Olga (cobranca03), saldo R$ 5.640,18.
--    Esperado DEPOIS: o acordo aparece para Olga; a ficha e os 2 titulos em
--    aberto seguem com a Luana; o acordo nao aparece na lista da Luana.
-- ---------------------------------------------------------------------------
select a.numero_acordo,
       left(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 3) || '.***.***-'
         || right(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 2) as cpf,
       round(coalesce(a.saldo, 0)::numeric, 2) as saldo,
       lower(al.responsavel_atual_email) as ficha_de,
       lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as acordo_de,
       (select count(*) from public.acordos_titulos t
         where t.aluno_id = a.aluno_id and upper(coalesce(t.situacao, '')) = 'ABERTO') as titulos_abertos_na_ficha
  from public.acordos a join public.alunos al on al.id = a.aluno_id
 where a.numero_acordo = 906 and upper(coalesce(a.status, '')) = 'ATIVO';
