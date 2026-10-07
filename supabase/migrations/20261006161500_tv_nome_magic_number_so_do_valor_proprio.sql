-- =============================================================================
-- TV ReATIVA — o nome "Magic Number" passa a ser SÓ do valor próprio
-- -----------------------------------------------------------------------------
-- Complemento de 20261006152000, que criou magic_number_mensal. Lá o alvo da
-- TELA deixou de ser meta x 1,5. Sobraram dois usos do nome dentro de
-- tv_snapshot_calcular(), apontando para coisas que NÃO são o Magic Number:
--
--   1) snap.metas: a linha do comparativo nasce com id 'magic'. O nome exibido
--      já era "Superar o mês passado" (o alvo são os honorários do mês
--      anterior), mas a chave 'magic' convida à confusão com o valor próprio.
--      O comparativo CONTINUA existindo — só perde a chave 'magic'.
--
--   2) snap.julho_historico: o card comemorativo de julho/2026 se chama
--      literalmente "Magic Number", com alvo fixo de R$ 500.000. É um número
--      histórico congelado, não o Magic da competência.
--
-- Decisão de 06/10/2026: "Magic Number" nomeia UMA coisa só — o valor
-- independente por competência em magic_number_mensal. Em outubro/2026:
-- Meta do Mês R$ 122.400,00 e Magic Number R$ 142.800,00.
--
-- POR QUE PATCH ANCORADO e não CREATE OR REPLACE da função inteira:
-- tv_snapshot_calcular() tem ~230 linhas e concentra todo o cálculo do
-- snapshot. Reescrevê-la a partir do texto do repositório apagaria qualquer
-- ajuste que exista só em produção. Aqui o corpo VIVO é lido com
-- pg_get_functiondef, só os dois trechos são trocados, e o bloco ABORTA se
-- alguma âncora não aparecer exatamente uma vez — nenhuma troca às cegas.
--
-- Nenhum cálculo muda: alvo, realizado e percentual dos dois cards seguem
-- idênticos. Só mudam uma chave e um rótulo.
--
-- DESFAZER: supabase/rollbacks/20261006161500_tv_nome_magic_number_so_do_valor_proprio.rollback.sql
-- =============================================================================

do $patch$
declare
  v_src  text;
  v_novo text;
  -- [de, para] — aplicados em ordem, cada um exigindo exatamente 1 ocorrência.
  v_trocas text[][] := array[
    array[
      $a$public._tv_meta_obj('magic','Superar o mês passado'$a$,
      $a$public._tv_meta_obj('superar_mes_anterior','Superar o mês passado'$a$
    ],
    array[
      $a$public._tv_meta_hist('Magic Number', 500000, v_hon)$a$,
      $a$public._tv_meta_hist('Superação de julho', 500000, v_hon)$a$
    ]
  ];
  v_de text; v_para text; v_n int; i int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular'
   limit 1;

  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco — nada a corrigir.';
  end if;

  v_novo := v_src;

  for i in 1 .. array_length(v_trocas, 1) loop
    v_de   := v_trocas[i][1];
    v_para := v_trocas[i][2];

    -- Conta ocorrências do trecho literal no corpo vivo.
    v_n := (length(v_novo) - length(replace(v_novo, v_de, ''))) / length(v_de);

    if v_n <> 1 then
      -- Já corrigido? Então a âncora NOVA é que tem de estar lá — e aí o bloco
      -- é idempotente e segue em frente. Qualquer outro caso aborta.
      if (length(v_novo) - length(replace(v_novo, v_para, ''))) / length(v_para) = 1 then
        raise notice 'troca % ja aplicada; seguindo.', i;
        continue;
      end if;
      raise exception
        'ancora % encontrada % vez(es) em tv_snapshot_calcular (esperado 1). Nada foi alterado. Trecho: %',
        i, v_n, left(v_de, 60);
    end if;

    v_novo := replace(v_novo, v_de, v_para);
  end loop;

  if v_novo = v_src then
    raise notice 'tv_snapshot_calcular ja estava sem o nome "Magic Number"; nada a fazer.';
    return;
  end if;

  -- Rede final: o nome só pode sobrar onde ele agora significa o valor próprio
  -- (em lugar nenhum desta função — a chave 'magic' do payload é mesclada em
  -- tv_snapshot_atualizar, não aqui).
  if position('Magic Number' in v_novo) > 0 then
    raise exception 'ainda restou "Magic Number" em tv_snapshot_calcular depois das trocas. Nada foi aplicado.';
  end if;

  execute v_novo;
end
$patch$;
