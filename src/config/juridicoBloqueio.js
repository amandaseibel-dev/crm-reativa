// Espelho de front da flag do servidor JURIDICO_BLOQUEIO_ENVIO_ATIVO (whatsapp-send e whatsapp-enviar-documento).
// O valor vem de VITE_JURIDICO_BLOQUEIO_ENVIO_ATIVO no BUILD. Ausente ou fora da lista = DESLIGADO.
// Precisa ser igual ao da função; se divergir, o aviso da aba Jurídico mente. Não é a fonte de verdade:
// quem decide o envio é o servidor.
const _RAW = import.meta.env?.VITE_JURIDICO_BLOQUEIO_ENVIO_ATIVO;
export const BLOQUEIO_ENVIO_JURIDICO_ATIVO = ["true", "1", "on", "yes", "sim"].includes(String(_RAW ?? "").trim().toLowerCase());
