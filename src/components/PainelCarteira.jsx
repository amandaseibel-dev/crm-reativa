Leu um arquivo
Leu um arquivo
Arquivo gerado: apenas src/components/PainelCarteira.jsx (substitui o atual; único alterado).
Componentes reutilizados: FilaReceptivo (rodízio/heartbeat/pausa/marcar/sair) e ReceberLeads (RPC receber_leads), importados sem modificação.
Comportamento da aba: duas abas — "Carteira" (padrão, intacta) e "Receptivo", que renderiza ReceberLeads + FilaReceptivo num container claro/neutro; após receber leads, aoReceber={carregar} recarrega a carteira e mostra os novos casos.
Banco/fidelização: inalterados — nenhum RPC/tabela/trigger novo, nenhum .rpc( adicionado neste arquivo, nenhuma lógica de "assumir aluno" nem vínculo paralelo; a distribuição segue só para casos sem responsável e os 10 dias permanecem 100% no servidor.
Validação: parse Babel (sourceType module + JSX) sem erros; imports e aoReceber=carregar confirmados; ausência de RPC/DDL confirmada. Build real fica pendente (repositório só-leitura, sem pasta local montada) — para compilar, aplique o arquivo no projeto e rode o build.
