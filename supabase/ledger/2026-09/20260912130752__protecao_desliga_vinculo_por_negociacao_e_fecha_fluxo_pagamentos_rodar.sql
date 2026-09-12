-- ETAPA DE PROTECAO (12/09/2026) -- dois atos, ambos reversiveis, nenhum dado
-- historico tocado.
--
-- ITEM 1. Desliga SO a etapa 'vinculo_por_negociacao' do fluxo horario.
--
-- POR QUE. prime_vincular_por_negociacao identifica a MENSALIDADE pelo numero
-- exato do boleto -- isso e prova. Mas escolhe o ACORDO por proximidade
-- temporal: `distinct on (matricula, liquidado_em) order by
-- (acordos.criado_em::date - liquidado_em)` entre os acordos do aluno criados
-- na janela de 3 dias. Com dois ou mais acordos candidatos ela escolhe o mais
-- proximo e NAO sinaliza nada. Medido nos 82 vinculos de hoje: 3 vinculos de 2
-- alunos tinham 2 e 3 acordos possiveis.
--
-- O QUE CONTINUA LIGADO, de proposito (ordem da gestao: "mantendo o restante"):
--   amarrar_boleto, pos_importacao, baixa_pelo_relatorio, sinalizar_duplicado.
--   Conferido: acordos_pos_importacao tambem escreve acordo_titulo_vinculo, mas
--   age em populacao DIFERENTE -- titulos com tipo_boleto='Acordo' e documento
--   de 12 digitos, casando por numero da parcela E valor com tolerancia de
--   R$ 0,05. Nao liga mensalidade a acordo, que e o risco desta trava.
--
-- NAO desfaz os 82 vinculos existentes. Restauracao, se um dia for decidida:
--   _backup_vinc_negociacao_20260912024025 / _034023 / _044025

do $$
declare v_antes boolean; v_obs text;
begin
  select ligado, observacao into v_antes, v_obs
    from public.fluxo_pagamentos_config where etapa = 'vinculo_por_negociacao';

  if v_antes is null then
    raise exception 'etapa vinculo_por_negociacao nao existe em fluxo_pagamentos_config';
  end if;

  -- guarda o estado anterior dentro da propria observacao: o rollback nao
  -- depende de ninguem lembrar qual era o valor.
  update public.fluxo_pagamentos_config
     set ligado = false,
         observacao = 'DESLIGADA EM 12/09/2026 pela gestao. Escolhe o acordo por proximidade temporal'
                   || ' e pode decidir em silencio entre varios acordos do mesmo aluno. Reativar so com'
                   || ' identificador explicito do acordo. | ESTADO ANTERIOR: ligado=' || v_antes::text
                   || ' / observacao anterior: ' || coalesce(v_obs, '(sem)'),
         alterado_em = now(),
         alterado_por = 'protecao_20260912_gestao'
   where etapa = 'vinculo_por_negociacao';

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'DESLIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
          jsonb_build_object(
            'etapa', 'vinculo_por_negociacao',
            'ligado_antes', v_antes,
            'ligado_depois', false,
            'observacao_antes', v_obs,
            'motivo', 'escolhe o acordo por proximidade temporal; pode decidir em silencio entre multiplos acordos',
            'vinculos_existentes_preservados', 270,
            'backups_para_eventual_restauracao',
              jsonb_build_array('_backup_vinc_negociacao_20260912024025',
                                '_backup_vinc_negociacao_20260912034023',
                                '_backup_vinc_negociacao_20260912044025')));
end $$;

-- ITEM 2. Fecha a exposicao de fluxo_pagamentos_rodar(text).
--
-- POR QUE. Ela e security definer, tinha EXECUTE para `authenticated`, nao tem
-- portao de permissao proprio (so o disjuntor de carga) e a primeira coisa que
-- faz e set_config('reativa.fluxo_pagamentos','on', true) -- a chave que abre o
-- portao de baixa_pelo_relatorio_pagamento(true, -180d), de
-- prime_vincular_por_negociacao(true, 3) e do recalculo de saldo em cadeia.
-- Qualquer operador logado podia disparar o fluxo financeiro inteiro.
-- Mesma classe de defeito que a Fase 2A corrigiu em fluxo_acordos_rodar.
--
-- Conferido antes de revogar: nenhuma tela em src/ e nenhuma Edge Function
-- chamam esta RPC. O cron fluxo_pagamentos_horario roda como `postgres`, que e
-- o dono da funcao, e o dono mantem EXECUTE implicito.

revoke all on function public.fluxo_pagamentos_rodar(text) from public, anon, authenticated;

-- Mesma varredura, mesmo motivo: leitura da fila de pagamentos sem aluno nao e
-- dado de operador. pagamentos_sem_aluno e security definer sem portao interno.
revoke all on function public.pagamentos_sem_aluno(text) from public, anon, authenticated;

-- PROVA, dentro da propria transacao. Se algo nao ficou como o esperado, a
-- migration falha e nada e aplicado.
do $$
declare v_ligado boolean; v_auth boolean; v_anon boolean; v_pub boolean; v_dono boolean;
begin
  select ligado into v_ligado from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
  if v_ligado is not false then
    raise exception 'etapa vinculo_por_negociacao continua ligada: %', v_ligado;
  end if;

  select has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('anon',          p.oid, 'EXECUTE'),
         has_function_privilege('public',        p.oid, 'EXECUTE'),
         has_function_privilege('postgres',      p.oid, 'EXECUTE')
    into v_auth, v_anon, v_pub, v_dono
    from pg_proc p where p.proname='fluxo_pagamentos_rodar';

  if v_auth or v_anon or v_pub then
    raise exception 'fluxo_pagamentos_rodar segue exposta: authenticated=% anon=% public=%', v_auth, v_anon, v_pub;
  end if;
  if not v_dono then
    raise exception 'fluxo_pagamentos_rodar perdeu o EXECUTE do dono -- o cron quebraria';
  end if;

  select has_function_privilege('authenticated', p.oid, 'EXECUTE') into v_auth
    from pg_proc p where p.proname='pagamentos_sem_aluno';
  if v_auth then
    raise exception 'pagamentos_sem_aluno segue chamavel por authenticated';
  end if;

  raise notice 'PROTECAO OK: etapa desligada, fluxo_pagamentos_rodar e pagamentos_sem_aluno fechadas, dono preservado';
end $$;
