-- MEDICAO DOS BLOQUEIOS DO GATE -- producao, 14/11/2026
-- SOMENTE LEITURA (so SELECT). Contagens e configuracao, sem conteudo pessoal.
select jsonb_build_object(
 'tmp_fila2_linhas', (select count(*) from public._tmp_fila2),
 'pagamento_suspeita_duplicidade_linhas', (select count(*) from public.pagamento_suspeita_duplicidade),
 'pagamento_suspeita_duplicidade_policies', (select count(*) from pg_policies where schemaname='public' and tablename='pagamento_suspeita_duplicidade'),
 'vw_pagamento_suspeita_pendente_linhas', (select count(*) from public.vw_pagamento_suspeita_pendente),
 'vw_extracao_calibragem_linhas', (select count(*) from public.vw_extracao_calibragem),
 'vw_titulo_presenca_historico_linhas', (select count(*) from public.vw_titulo_presenca_historico),
 'bucket_tv_imagens_public', (select public from storage.buckets where id='tv-imagens'),
 'bucket_tv_imagens_objetos', (select count(*) from storage.objects where bucket_id='tv-imagens'),
 'tv_config_imagens_itens', (select jsonb_array_length(valor->'itens') from public.tv_config where chave='imagens')
) as medicao;
