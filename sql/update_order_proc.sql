
-- Update the order numbering procedure to support regional prefixes
DROP PROCEDURE IF EXISTS generate_order_number;

DELIMITER //

CREATE PROCEDURE generate_order_number(IN p_country VARCHAR(10), OUT new_order_number VARCHAR(25))
BEGIN
    DECLARE next_number INT;
    
    -- CA Orders: Prefix 'DG-' (Detail Guardz Canada)
    -- US Orders: Prefix 'AMZ-' (Amazon USA)
    
    IF p_country = 'CA' THEN
        INSERT INTO order_sequences (year, month, last_number, prefix)
          VALUES (1, 1, 10001, 'DG')
        ON DUPLICATE KEY UPDATE last_number = last_number + 1;
        
        SELECT last_number INTO next_number FROM order_sequences WHERE year = 1 AND month = 1;
        SET new_order_number = CONCAT('DG-', next_number);
    ELSE
        INSERT INTO order_sequences (year, month, last_number, prefix)
          VALUES (2, 1, 10001, 'AMZ')
        ON DUPLICATE KEY UPDATE last_number = last_number + 1;
        
        SELECT last_number INTO next_number FROM order_sequences WHERE year = 2 AND month = 1;
        SET new_order_number = CONCAT('AMZ-', next_number);
    END IF;
END //

DELIMITER ;
